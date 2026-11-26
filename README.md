# ais-its-notification-service

Alert inbox, alert rules and deliveries (e-mail, Telegram, webhook), transactional e-mail and the
realtime WebSocket gateway of **AIS Maritime Intelligence** v2.

Service `notification` (port 3008, PostgreSQL schema `notify`): NestJS 12 + Fastify on the platform
kit [`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest)
and the contracts [`@darmawanweb/ais-its-contracts`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/contracts),
TimescaleDB + PostGIS, NATS JetStream, socket.io. The normative engineering spec is
[`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) (§9 realtime protocol, §13.9 this service)
in the central repository ([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose

The safety and surveillance detectors raise alerts; the emission service computes CII; the AIS
pipeline records positions. This service is where people **see and receive** all of that:

- **Alert inbox** — every `alert.raised.v1` (domain `safety` | `surveillance`, with the `methodId`
  of the detector rule) is stored once; occurrences with the same `dedupKey` merge into the
  unresolved alert (`occurrences++`, severity escalation) and are kept as its occurrence history.
  The detector's `alert.resolved.v1` resolves it when the condition ended. Users list, filter,
  export (CSV), chart (time series), mark read, acknowledge and resolve alerts with the tenancy of
  spec §8.5.
- **Alert rules and deliveries** — organizations define rules (type / domain, minimum severity,
  vessels, zones, quiet period) with channels: e-mail, Telegram, signed webhooks. Each matching
  channel becomes a `deliveries` row, sent with exponential retries.
- **Transactional e-mail** — the `NOTIFY` work queue (password resets and invitations from auth,
  alert and test e-mails from this service) is rendered from bilingual (`id` / `en`) templates
  with HTML escaping and sent over SMTP with nodemailer.
- **Realtime gateway** — socket.io at `/ws` on the same port: positions and safety states batched
  per map tile, vessel rooms, alert and CII pushes (spec §9).

It owns the schema `notify` only. It does **not** detect anything (detectors live in safety and
surveillance), does not compute CII, and does not serve the initial map state (that comes from
`GET /api/v2/ais/latest` and `GET /api/v2/safety/vessels`).

## Architecture

```mermaid
flowchart LR
  subgraph NATS["NATS JetStream"]
    ALERTS[(ALERTS<br/>alert.v1.&gt;)]
    NOTIFY[(NOTIFY<br/>notify.email.v1)]
    FLEET[(FLEET<br/>fleet.vessel.v1.&gt;)]
    POS[(AIS_POSITION)]
    SAF[(SAFETY)]
    EMI[(EMISSION)]
    FAN{{core: aisits.notification.realtime.v1<br/>contracts notification-realtime-fanout}}
  end

  subgraph svc["notification (one or more instances)"]
    AC["AlertsConsumer<br/>durable notification-alerts"]
    ING["AlertIngestService<br/>raise: merge (dedup_key) + history + deliveries<br/>resolution: resolve<br/>one transaction each"]
    DW["DeliveryWorker<br/>slot pool, SKIP LOCKED claims, leases, backoff"]
    EC["EmailConsumer<br/>durable notification-email"]
    FP["FleetProjection<br/>durable notification-fleet"]
    RS["RealtimeStreams<br/>ordered consumers (per instance)"]
    HUB["RealtimeHub<br/>VesselLiveState + RealtimeBatcher"]
    GW["RealtimeGateway<br/>socket.io /ws"]
    REST["REST /api/v2<br/>alerts, alert-rules, notifications"]
  end

  DB[("PostgreSQL schema notify<br/>alerts, alert_occurrences (hypertables), open_alerts,<br/>alert_read_marks, alert_rules, webhook_keys,<br/>deliveries, email_log, vessels")]
  SMTP[[SMTP / Mailpit]]
  TG[[Telegram Bot API]]
  WH[[Webhook receivers]]
  WEB[[Web app]]

  ALERTS --> AC --> ING --> DB
  ING -- after commit --> FAN
  ING -- wake --> DW
  DW --> DB
  DW -- e-mail --> NOTIFY
  DW --> TG
  DW -- signed POST --> WH
  NOTIFY --> EC --> SMTP
  EC -- delivery sent/failed --> DB
  FLEET --> FP --> DB
  POS & SAF & EMI --> RS --> HUB
  FAN --> HUB
  HUB --> GW <--> WEB
  REST <--> WEB
  REST --> DB
  REST -- ack / resolve --> FAN
```

- **Inbox**: `AlertIngestService` runs one transaction per alert, idempotent by envelope id
  (`withIdempotency`, table `processed_events`) and serialized per `dedupKey` (advisory lock); it
  stores or merges the alert (pure `mergeOccurrence`), matches the rules (pure `ruleMatchesAlert`,
  `isWithinQuietPeriod`) and inserts the deliveries **in the same transaction**, so an alert is
  never stored without its deliveries. After the commit it fans the push out and wakes the
  delivery worker. The unresolved alert of a key is found through the regular table
  `open_alerts` and read **without row locks** (TimescaleDB cannot lock tuples of compressed
  chunks, and an alert may stay unresolved long after its chunk was compressed); the merge
  update is conditional on the status it read, so a concurrent acknowledge / resolve wins and
  the occurrence is applied again to the new state (resolved: a new alert). Every stored
  occurrence is also written to `alert_occurrences` (the alert row keeps only the highest
  severity and the newest details).
- **Resolutions**: `alert.resolved.v1` comes through the same durable consumer on the raise's
  subject, so in the stream it follows the raises of its occurrence. The kit does not keep that
  order everywhere: a nak'd raise is redelivered after its backoff, after later messages of its
  subject, and per-subject order holds within one process only, so replicas may handle a raise
  and its resolution at the same time. Under the same advisory lock the resolution therefore
  first checks that the raise it names is stored (`alertId`, the envelope id of the occurrence's
  last raise: the alert's first raise, an id in `processed_events` or an entry of the alert's
  history; the lock holder's uncommitted raise does not count). If not, it fails retryably (nak
  with the consumer's backoff, about 4 minutes over the 10 deliveries) and is applied after the
  raise, which also keeps an escalation from opening a new alert after the resolution; on its
  last delivery it is applied to the inbox as it is instead of being dead-lettered. Then the
  unresolved (open or acknowledged) alert of the `dedupKey` is resolved by the system
  (`resolved_by` = `NULL`, `resolved_at` = `resolvedAt`, reason, event id and the event's data
  kept) and removed from `open_alerts` — unless it merged an occurrence later than `resolvedAt`
  (a re-raise handled before a redelivered resolution; pure `resolveByDetector`), or there is
  none. Idempotent by envelope id (`processed_events`); no rule deliveries and no audit record
  (the event in `ALERTS` is the record); `alert:updated` is pushed through the fan-out to the
  vessels' current owners (as for an acknowledge or resolve over REST). The detectors (kit 0.3
  `AlertEmitter`) publish a resolution only
  once their alert cooldown since the last raise has passed, and a re-raise within it cancels it,
  so flapping conditions do not open and close inbox alerts.
- **Deliveries**: every instance runs a pool of `DELIVERY_CONCURRENCY` attempt slots, refilled
  as soon as a slot frees up (and polled every `DELIVERY_POLL_INTERVAL_MS`); claims are exclusive
  (`FOR UPDATE SKIP LOCKED`) and leased (`DELIVERY_LEASE_MS`, at least twice the longest channel
  timeout), so instances share the work and an attempt of a crashed instance is retried after its
  lease. Each attempt has a total deadline (`WEBHOOK_TIMEOUT_MS` / `TELEGRAM_TIMEOUT_MS`), so a
  slow receiver holds one slot for at most that long and never delays other tenants. Failures are
  retried after `base × 2^(attempt − 1)` (honouring `Retry-After` / Telegram `retry_after`) up to
  `DELIVERY_MAX_ATTEMPTS`; permanent refusals (4xx, unknown chat) fail at once. E-mail deliveries
  are handed to `NOTIFY` (status `queued`); the e-mail consumer marks them `sent` or `failed`, and
  the hourly housekeeping queues lost requests again (see Operations).
- **E-mail**: each SMTP exchange runs under a claim of the request's `email_log` row (`sending`
  until `claimed_until`), so two copies of one request send it once. Once the SMTP server accepted
  a message it is never sent again: the log row and the alert delivery are recorded in one
  transaction, retried in place, and remembered in memory when the database keeps failing (the
  redelivered request only redoes the bookkeeping).
- **Realtime**: every instance runs its own ordered (ephemeral) consumers on `AIS_POSITION`
  (`new`), `SAFETY` (`last_per_subject`, warming the latest state of every vessel) and `EMISSION`
  (`new`), and pushes to its own clients. Alert pushes (from the durable consumer or a REST
  ack/resolve on _some_ instance) are fanned out to all instances through the contracts core
  subscription `notification-realtime-fanout` (`aisits.notification.realtime.v1`,
  `delivery: 'fanout'`, payload `RealtimeAlertFanoutSchema`, validated by the kit on receipt; no
  stream, best effort, the inbox stays the source of truth).
  The batching is a pure, socket-free component (`src/domain/realtime/realtime-batcher.ts`).

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
start consumers, timers and the gateway (`onApplicationBootstrap`) → the port opens. On `SIGTERM`
readiness turns `503`, realtime clients are disconnected (they reconnect to another instance),
consumers and NATS drain, the delivery worker finishes its attempts and the pool closes.

| Path                              | What                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/domain/`                     | pure rules with `@method` TSDoc: merge, lifecycle, matching, quiet period, retry, signature |
| `src/domain/realtime/`            | viewport rooms, latest-per-vessel batching, live vessel state (no sockets)                  |
| `src/modules/alerts/`             | `notification-alerts` consumer (raises, resolutions), ingest + planner, inbox REST, CSV     |
| `src/modules/rules/`              | alert rules CRUD (tenant-private), webhook secret rotation                                  |
| `src/modules/deliveries/`         | delivery worker, channels (e-mail, Telegram, webhook + keys), tests, delivery summary       |
| `src/modules/email/`              | `notification-email` consumer, templates (`id` / `en`), SMTP mailer                         |
| `src/modules/realtime/`           | socket.io gateway, hub, ordered consumers, alert fan-out                                    |
| `src/modules/vessels/`            | `notification-fleet` projection (mmsi → owner organization, tombstones)                     |
| `src/modules/housekeeping/`       | retention of bookkeeping rows, requeue of lost alert e-mails                                |
| `src/cors.ts`                     | exposed CORS headers of the CSV export                                                      |
| `src/modules/methodology/`        | `GET /api/v2/notifications/methodology`                                                     |
| `migrations/`, `src/db/schema.ts` | forward-only SQL and its drizzle mirror                                                     |
| `test/`                           | integration tests (`*.int.test.ts`) against real containers                                 |

## Data model

| Table               | Kind                                     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts`            | hypertable on `occurred_at` (7 d chunks) | `id` (= alert / envelope id of the first occurrence), `type`, `domain`, `severity` (highest merged), `mmsi`, `related_mmsi`, `org_id` (vessel owner when stored), `title`, `message`, `lat`, `lon`, `zone_id`, `method_id`, `dedup_key`, `data`, `source`, `status` (`open` / `acknowledged` / `resolved`), `acknowledged_by/at`, `resolved_by/at` (`resolved_by` `NULL` with a resolution: the detector), `resolution_reason` / `resolution_event_id` / `resolution_data` (of the `alert.resolved.v1`), `occurrences`, `last_occurred_at`. Compressed after 90 days (segment `mmsi`), dropped after 2 years. |
| `alert_occurrences` | hypertable on the alert's `occurred_at`  | one row per stored `alert.raised.v1`: `alert_id`, `event_id`, `occurred_at`, `outcome` (`raised` / `merged` / `escalated`), its own `severity`, `title`, `message`, `lat`, `lon`, `related_mmsi`, `zone_id`, `method_id`, `data`, `received_at`. Partitioned by the alert's first occurrence, so it is dropped with the alert (2 years). Alerts from before 0.2.0 have no rows.                                                                                                                                                                                                                               |
| `open_alerts`       | table                                    | `dedup_key` (PK), `alert_id`, `occurred_at`, `mmsi`: the unresolved alert of each dedup key (merge lookup by primary key, also for alerts in compressed chunks). Inserted with the alert, removed by a resolve; entries of alerts dropped by the retention policy are pruned.                                                                                                                                                                                                                                                                                                                                 |
| `alert_read_marks`  | table                                    | `user_id`, `org_id` (active organization, `NULL` = none; unique together), `read_up_to`: the read mark of `GET /alerts/unread-count` (only moves forward).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `alert_rules`       | table                                    | `org_id`, `created_by`, `name`, `scope` (`org` = own fleet, `all` = every vessel, rules of authority organizations only), `types[]`, `domains[]`, `min_severity`, `mmsi[]`, `zone_ids[]`, `channels` jsonb `[{ type, target }]` (1–10), `locale` (`id` / `en`), `quiet_minutes`, `enabled`. Empty lists match everything.                                                                                                                                                                                                                                                                                     |
| `webhook_keys`      | table                                    | `id` (key id, `X-AIS-ITS-Key-Id`), `rule_id` (cascade), `target`, `secret` (`whsec_…`, needed in clear to sign; never returned after creation), `created_at`; one per rule and webhook target. Channels from before 0.2.0 have none until rotated.                                                                                                                                                                                                                                                                                                                                                            |
| `deliveries`        | table                                    | `alert_id`, `rule_id` (cascade), `channel`, `target`, `severity` (when planned), `status` (`pending` → `sending` → `sent` / `failed`; e-mail `sending` → `queued` → `sent` / `failed`), `attempts`, `error`, `payload` (alert as pushed, rule and vessel names, locale, link), `next_attempt_at`, `lease_until`, `sent_at`.                                                                                                                                                                                                                                                                                   |
| `email_log`         | table                                    | one row per `notify.email.requested.v1` envelope (idempotency key): recipient, template, locale, subject, source, `delivery_id`, `status` (`sending` / `retrying` / `sent` / `failed`), `claimed_until` (claim of a `sending` attempt), `attempts` (claims), `error`, SMTP `message_id`. Bodies are never stored (reset links).                                                                                                                                                                                                                                                                               |
| `vessels`           | projection of `FLEET`                    | `vessel_id`, `mmsi` (unique among live vessels), `org_id`, `name`, `updated_at`, `deleted_at` — a snapshot never overwrites a newer one; a deleted vessel stays as a tombstone that ignores every later snapshot.                                                                                                                                                                                                                                                                                                                                                                                             |
| `processed_events`  | idempotency                              | `(consumer, event_id)` of handled alert envelopes, kept `IDEMPOTENCY_RETENTION_DAYS` (≥ the 90 days of `ALERTS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Finished deliveries and e-mail log rows are pruned after `NOTIFICATION_LOG_RETENTION_DAYS` by the
hourly housekeeping job.

## API

All routes under `/api/v2` (gateway prefixes `/api/v2/alerts`, `/api/v2/alert-rules`,
`/api/v2/notifications`, `/ws` → this service, spec §12). Lists follow spec §5 (cursor pages for
alerts and deliveries, page-based for rules); errors are RFC 9457 problem details. The OpenAPI
document is [`openapi.json`](openapi.json) (`pnpm openapi`), served at `/openapi.json` and `/docs`.

| Method   | Path                                             | Permission         | What                                                                                                                                |
| -------- | ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/alerts`                                        | `alert:read`       | `status, type, domain, severity, mmsi, from, to, cursor, limit` — newest first                                                      |
| `GET`    | `/alerts/summary`                                | `alert:read`       | open alerts by severity, domain and type (every registry type, 0 when none)                                                         |
| `GET`    | `/alerts/unread-count`                           | `alert:read`       | `{ unread, readUpTo }`: open alerts stored or changed after the user's read mark in the active organization                         |
| `POST`   | `/alerts/read`                                   | `alert:read`       | `{ upTo? }` (default and maximum now; bodiless allowed) moves the read mark forward → `{ unread, readUpTo }`                        |
| `GET`    | `/alerts/stats/series`                           | `alert:read`       | counts per local hour / day of the first occurrence: `from, to, bucket=1h\|1d, groupBy=severity\|type\|domain, tz` + filters        |
| `GET`    | `/alerts/export.csv`                             | `alert:read`       | the filters of `GET /alerts` as streamed CSV (headers in `Accept-Language` `id` / `en`), ≤ `ALERT_EXPORT_MAX_ROWS` rows             |
| `GET`    | `/alerts/:id`                                    | `alert:read`       | one alert (`404 ALERT_NOT_FOUND` also for other tenants' alerts)                                                                    |
| `GET`    | `/alerts/:id/occurrences`                        | `alert:read`       | its occurrence history, newest first: `cursor, limit` (tenancy of `GET /alerts/:id`)                                                |
| `POST`   | `/alerts/:id/ack`                                | `alert:ack`        | open → acknowledged (idempotent; `409 ALERT_ALREADY_RESOLVED`); pushes `alert:updated`                                              |
| `POST`   | `/alerts/:id/resolve`                            | `alert:ack`        | → resolved (idempotent); pushes `alert:updated`                                                                                     |
| `GET`    | `/alert-rules`                                   | `alert_rule:write` | rules of the active organization (`super_admin`: all, `orgId` filter), `page, pageSize, enabled`                                    |
| `POST`   | `/alert-rules`                                   | `alert_rule:write` | create in the active organization (`super_admin` may set `orgId`); webhook channels get their keys (secret shown once)              |
| `GET`    | `/alert-rules/:id`                               | `alert_rule:write` | one rule (webhook channels with `keyId`)                                                                                            |
| `PATCH`  | `/alert-rules/:id`                               | `alert_rule:write` | change (the organization cannot change); new webhook targets get keys, removed ones lose theirs                                     |
| `POST`   | `/alert-rules/:id/channels/:index/rotate-secret` | `alert_rule:write` | new signing key of the webhook channel at `index` (secret shown once; `404 RULE_CHANNEL_NOT_FOUND`, `422 RULE_CHANNEL_NOT_WEBHOOK`) |
| `DELETE` | `/alert-rules/:id`                               | `alert_rule:write` | delete with its delivery history and keys                                                                                           |
| `POST`   | `/notifications/test`                            | `alert_rule:write` | `{ channel, target, locale? }` — Telegram / webhook sent at once, e-mail queued; 10 / user / 10 min; `keyId` of a webhook test      |
| `GET`    | `/notifications/deliveries`                      | `alert_rule:write` | delivery log of the organization's rules: `ruleId, alertId, status, cursor, limit`                                                  |
| `GET`    | `/notifications/deliveries/summary`              | `alert_rule:write` | `{ sent, failed, pending, queued, total, lastDeliveredAt, successRate }` of deliveries planned in `from, to` (30 d), `ruleId`       |
| `GET`    | `/notifications/methodology`                     | signed-in user     | methods implemented here (spec §17)                                                                                                 |

Outside the prefix: `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`,
`GET /openapi.json`, socket.io at `/ws`.

**Tenancy (spec §8.5).** `authority` and `super_admin` see every alert; other roles see the
alerts whose vessel **or related vessel** belongs to their active organization (evaluated against
the current `FLEET` projection); without an organization nothing. Rules and deliveries are
tenant-private (`super_admin` manages all). Rules of scope `all` ("authority-org rules may match
any vessel") belong to authority organizations: a rule gets or keeps scope `all` only when it is
written by a member holding the `authority` role **in the rule's own organization** (the token's
roles are those of the active organization, and auth grants `authority` only in organizations of
kind `authority`) — the default scope of such a rule is `all`, of every other rule `org`, also when
a `super_admin` creates it for a shipping company. Every change of a rule whose scope is `all`
(channels, criteria, scope) needs that authority membership or `super_admin`, so other members
cannot redirect the cross-tenant feed; others get `403 RULE_SCOPE_FORBIDDEN` (also for rotating a
channel secret of such a rule). Optional body fields may be omitted but never `null`
(`400 VALIDATION_FAILED`, kit `@IsOptionalNotNull()`); path parameters are checked by the kit
(`@UuidParam()`, `@IntParam()`: `400 VALIDATION_FAILED` with `field: 'id'` / `'index'`); bodiless
`POST`s with `Content-Type: application/json` are accepted (acks, `POST /alerts/read`). Read marks,
series and exports use the tenancy of `GET /alerts` (series: the scope of `/alerts/summary`).
Error codes: `ALERT_NOT_FOUND`, `ALERT_ALREADY_RESOLVED`, `ALERT_RULE_NOT_FOUND`,
`RULE_CHANNEL_NOT_FOUND` (404), `RULE_CHANNEL_NOT_WEBHOOK` (422), `RULE_SCOPE_FORBIDDEN`,
`ORGANIZATION_REQUIRED`, `CHANNEL_NOT_CONFIGURED` (422: Telegram without `TELEGRAM_BOT_TOKEN`),
`VALIDATION_FAILED`, `RATE_LIMITED`, `CONFLICT`.

### Inbox alerts, history, read marks, series and export

- **Localizable texts** (platform convention): safety and surveillance put a stable `messageKey`
  (`<domain>.<detector>.<situation>`) and `messageParams` (flat strings, numbers, booleans) into
  the alert `data`. `AlertDto` and `AlertOccurrenceDto` expose them as `messageKey: string | null`
  and `messageParams: object | null`, read from `data` and validated (key
  `^[a-z0-9_]+(\.[a-z0-9_]+)+$`, ≤ 128 characters; params flat primitives; otherwise both `null`:
  render `title` / `message`). `resolutionMessageKey` / `resolutionMessageParams` come from the
  data of the `alert.resolved.v1` (`resolutionReason` is its English `reason`). `data` itself is
  unchanged, also in the realtime payload; e-mails and webhooks keep the English `title` /
  `message`. Keys and their texts are documented by the producers (safety README "Localizable
  texts", surveillance events).
- **Resolution fields**: `resolvedBy` is the user, or `null` when the detector resolved the alert
  (then `resolutionEventId` is set and `resolvedAt` is the end of the condition).
- **History** (`GET /alerts/:id/occurrences`): every `alert.raised.v1` stored in the alert, with its
  own severity, texts and `data` (`outcome` `raised` / `escalated` / `merged`), cursor pages newest
  first. Detectors publish no de-escalations (the kit's emitter announces raises and escalations
  only), so the history has none. Alerts stored before 0.2.0 have no history (`occurrences` still
  counts them).
- **Read marks**: per user **and** active organization, only moving forward. Unread = open alerts
  visible to the user whose `updatedAt` (stored, merged or reopened) is after the mark; without a
  mark every open alert. `upTo` lets a client mark read up to the newest alert it showed.
- **Series** (`GET /alerts/stats/series`): `bucket` `1h` / `1d` (default), `groupBy` `severity`
  (default) / `type` / `domain`, `tz` an IANA name (default `UTC`; `Asia/Jakarta` for WIB days; UTC
  offsets are refused because PostgreSQL reads them with the opposite sign), counted by the first
  occurrence (`occurred_at`) with the filters of `GET /alerts`. Every bucket from the one containing
  `from` to the one containing `to` is returned (zeros included; DST days are 23–25 h), the first
  starting at `from` and the last ending at `to` (inclusive, like the filter): a partial bucket
  counts only its part of the range, so the totals add up to `GET /alerts` with the same filters
  (when `to` is a bucket start, that instant ends the bucket before). `keys` lists every registry
  value of the dimension plus other types present. Default range 7 days (`1d`) or 24 hours
  (`1h`); more than 1 000 buckets as returned (partial ones included) → `400`.
- **CSV export** (`GET /alerts/export.csv`): RFC 4180, UTF-8, CRLF, newest first, read in pages of
  1 000 while the client consumes the stream. Headers in `id` (default) or `en` from
  `Accept-Language` (`Content-Language`, `Vary: Accept-Language`); values are the stored codes, UTC
  ISO-8601 times and the English texts; cells that a spreadsheet would evaluate (`=`, `+`, `-`, `@`)
  get a leading `'`. More than `ALERT_EXPORT_MAX_ROWS` matching alerts → the first ones and
  `X-Truncated: true`. `Content-Disposition`, `Content-Language` and `X-Truncated` are exposed to
  cross-origin clients (`src/cors.ts`).

### Rule matching

A rule matches an alert when **all** hold (empty lists do not restrict): enabled; scope `org` →
the alert's vessel or related vessel belongs to the rule's organization (scope `all`: any vessel);
`types` contains the type (open vocabulary: future types work); `domains` contains the domain;
severity ≥ `minSeverity` (`info < warning < critical`); `mmsi` contains the vessel or related
vessel; `zoneIds` contains the alert's zone. **Quiet period:** after a rule notified an alert, new
occurrences of the same alert are not notified again by that rule for `quietMinutes` — unless
the severity rose (escalations always notify); other alerts are never held back.

### Webhooks

`POST <target>` with `Content-Type: application/json`, no redirects followed. Each attempt has a
**total** deadline of `WEBHOOK_TIMEOUT_MS` (DNS, connect, TLS, request and response head); the
outcome is the status line — the response body is never read, so a receiver that answers slowly
or drips its body cannot hold the attempt. 2xx = sent, 408 / 429 / 5xx / network errors and
timeouts are retried, other statuses fail for good. Loopback, private and link-local targets are refused (also after DNS resolution)
unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.

| Header                | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `X-AIS-ITS-Timestamp` | signing time, Unix seconds                                                                            |
| `X-AIS-ITS-Signature` | `sha256=<hex HMAC-SHA256(<secret of the key>, "<timestamp>.<raw body>")>`                             |
| `X-AIS-ITS-Key-Id`    | the key that signed: the channel's `keyId` (UUID), `deployment` (channel from before 0.2.0) or `test` |
| `X-AIS-ITS-Delivery`  | delivery id (deduplicate retries with it)                                                             |

**Signing keys.** Every webhook channel (rule + target URL) has its own secret (`whsec_` + 32
random bytes), so a tenant's receivers can verify only what is meant for them. The secret is
returned **once**, as `channels[i].signingSecret` of the `POST /alert-rules` response, of the
`PATCH` that adds the target, or of `POST /alert-rules/:id/channels/:index/rotate-secret`; every
other response shows only `keyId`. A target that stays in a `PATCH` keeps its key; a removed one
loses it. Rotation applies at once, also to pending retries: receivers hold the old and the new
secret by `X-AIS-ITS-Key-Id` while they switch. Channels created before 0.2.0 have no key and are
signed with the deployment secret `WEBHOOK_SIGNING_SECRET` (key id `deployment`) until their
secret is rotated; without that variable their deliveries fail (`no signing key`). Test
notifications to a target that is a channel of the organization are signed with its key (or
`deployment`); to any other target with a throwaway key (`test`), so they prove reachability and
the format only. Secrets are stored in clear in `webhook_keys` (HMAC needs them), never logged and
never returned again.

Body: `{ deliveryId, event: "alert.raised" | "alert.escalated" | "alert.recurred" | "test", sentAt,
locale, rule: { id, name }, vessel: { mmsi, name }, alert: RealtimeAlert, link, text }`.
Receivers pick the secret by `X-AIS-ITS-Key-Id`, recompute the HMAC over the exact raw body and
reject timestamps older than a few minutes (see `verifyWebhookSignature` in
`src/domain/webhook-signature.ts`):

```ts
const expected =
  'sha256=' +
  createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
const valid =
  timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) &&
  Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
```

### Telegram

Bot API `POST {TELEGRAM_API_BASE}/bot<TELEGRAM_BOT_TOKEN>/sendMessage` with `parse_mode: HTML`
(every text escaped, clipped to Telegram's 4 096 visible characters). Targets are chat ids
(`-100…` for groups/channels) or `@channelusername`; the bot must be a member. 429 / 5xx are
retried (honouring `retry_after`), other refusals fail for good. The token never reaches logs or
stored errors.

### Realtime protocol (socket.io at `/ws`, spec §9)

Same origin and port, `io(origin, { path: '/ws', auth: { token: <access token> } })`. The
handshake token is verified like HTTP bearer tokens (kit `AccessTokenVerifier`, JWKS of auth);
missing, invalid or expired tokens → `connect_error` with `err.data = { code: 'UNAUTHORIZED' }`
(`SERVICE_UNAVAILABLE` while the signing keys cannot be fetched). When the token expires the
transport is closed and clients reconnect with a fresh one (`REALTIME_REAUTH_ON_TOKEN_EXPIRY`).
On connect the socket joins `user:<userId>`, `org:<orgId>` (if any) and `authority` (roles
`authority` / `super_admin`). Requests are validated with the contracts `realtime` zod schemas
and acknowledged `{ ok: true, data } | { ok: false, error: { code, message } }`.

| Direction | Event                                     | Payload / behaviour                                                                                                                                             |
| --------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C → S     | `viewport:set`                            | `{ bbox, zoom }` → rooms `tile:6:<x>:<y>` covering the box (contracts tile math), or `tile:all` beyond 64 tiles; previous rooms left; ack `{ mode, tileCount }` |
| C → S     | `vessel:subscribe` / `vessel:unsubscribe` | `{ mmsi }` → room `vessel:<mmsi>` (≤ `REALTIME_MAX_VESSEL_SUBSCRIPTIONS`); subscribing sends the latest known position and safety state                         |
| S → C     | `positions`                               | `{ at, items: RealtimePosition[] }` per tile room every 1 s, latest position per vessel in the window; `tile:all` every 5 s                                     |
| S → C     | `safety:states`                           | `{ at, items: RealtimeSafetyState[] }` same batching (state at the vessel's latest position)                                                                    |
| S → C     | `vessel:position` / `vessel:safety`       | immediately, room `vessel:<mmsi>`                                                                                                                               |
| S → C     | `alert:raised` / `alert:updated`          | `RealtimeAlert` to `authority` and `org:<owner>` of the vessel and related vessel                                                                               |
| S → C     | `cii:updated`                             | `CiiUpdatedV1` to `org:<orgId>`                                                                                                                                 |

`SafetyVesselStateV1` has no coordinates: a state is pushed at the latest known position of its
vessel (a state that arrives before any position waits for the first one). Rooms without a member
on an instance are skipped. Inbound NATS payloads are validated by the kit with the contracts
schemas; outbound shapes are built with the contracts projections (`toRealtimePosition`,
`toRealtimeSafetyState`) and alert pushes are validated with `RealtimeAlertFanoutSchema` when
published and by the kit when received (invalid ones are dropped and counted as
`aisits_core_messages_total{outcome="invalid"}`). `alert:updated` follows acknowledgements,
resolutions by users and by detectors, merges and escalations.

## Events

| Direction | Stream / subject                            | Type                                                  | Consumer / producer                                                                                        |
| --------- | ------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| consumes  | `ALERTS` `alert.v1.<type>.<mmsi>`           | `alert.raised.v1`, `alert.resolved.v1`                | durable `notification-alerts` (concurrency 4, per-vessel order; a resolution waits for its raise)          |
| consumes  | `NOTIFY` `notify.email.v1` (work queue)     | `notify.email.requested.v1`                           | durable `notification-email` (concurrency 4 without per-subject order, ack wait 60 s)                      |
| consumes  | `FLEET` `fleet.vessel.v1.<vesselId>`        | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1` | durable `notification-fleet` (concurrency 4, per-vessel order)                                             |
| consumes  | `AIS_POSITION` `ais.position.v1.<p>.<mmsi>` | `ais.position.recorded.v1`                            | ordered `notification-positions` per instance (`new`)                                                      |
| consumes  | `SAFETY` `safety.state.v1.<mmsi>`           | `safety.vessel_state.updated.v1`                      | ordered `notification-safety` per instance (`last_per_subject`)                                            |
| consumes  | `EMISSION` `emission.cii.v1.<mmsi>`         | `emission.cii.updated.v1`                             | ordered `notification-cii` per instance (`new`)                                                            |
| produces  | `NOTIFY` `notify.email.v1`                  | `notify.email.requested.v1`                           | alert e-mails (envelope id = delivery id) and test e-mails                                                 |
| produces  | `AUDIT` `audit.v1.notification`             | `audit.recorded.v1`                                   | `alert.acknowledge`, `alert.resolve`, `alert_rule.create/update/delete/rotate_secret`, `notification.test` |
| both      | core `aisits.notification.realtime.v1`      | `RealtimeAlertFanout` `{ event, rooms, alert }`       | contracts subscription `notification-realtime-fanout` (`delivery: 'fanout'`, every instance)               |

Streams produced to (`NOTIFY`, `AUDIT`) are created or widened on boot; consumed streams are only
created when missing. Invalid messages are terminated and counted; transient failures are retried
with backoff and dead-lettered to `dlq.<stream>.<consumer>` after 10 deliveries. Handlers are
idempotent: alerts and resolutions by envelope id (`processed_events`) and per `dedupKey` (a
resolution redelivered after a later re-raise is ignored: `last_occurred_at > resolvedAt`), e-mails by envelope id
(`email_log`, claimed before the SMTP exchange: all requests share one subject, so the consumer
handles them concurrently and two copies of one request send it once), the projection by
`updatedAt` and deletion tombstones (a redelivered older upsert never brings a deleted vessel
back).

**E-mail templates** (`data` of `notify.email.requested.v1`, validated per template; invalid data
is never retried; links must be absolute http(s) URLs; every value is HTML-escaped):

| Template         | `data`                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| `password_reset` | `{ link, name?, expiresInMinutes? }`                                     |
| `account_invite` | `{ link, name?, organizationName?, role?, invitedBy?, expiresInHours? }` |
| `alert`          | `{ alert: RealtimeAlert, link, vesselName?, ruleName?, deliveryId? }`    |
| `test`           | `{ message?, requestedBy? }`                                             |

## Configuration

Validated with zod at boot (`src/config.ts`); the service refuses to start on invalid values and
prints every problem. Every variable is in [`.env.example`](.env.example).

| Variable                                                                   | Default                                                  | Notes                                                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                                                 | `development`                                            | `development` \| `test` \| `production` (production refuses the dev secrets) |
| `SERVICE_NAME` / `SERVICE_VERSION`                                         | `notification` / package version                         | logs, metrics, event `source`                                                |
| `HOST` / `PORT`                                                            | `0.0.0.0` / `3008`                                       | HTTP and socket.io (`/ws`)                                                   |
| `LOG_LEVEL` / `LOG_PRETTY`                                                 | `info` / `true` in development                           | pino                                                                         |
| `SHUTDOWN_TIMEOUT_MS`                                                      | `30000`                                                  | graceful shutdown deadline                                                   |
| `DATABASE_URL`                                                             | `postgres://notify_svc:notify_svc@localhost:5432/aisits` |                                                                              |
| `DATABASE_SCHEMA` / `DATABASE_POOL_MAX` / `DATABASE_STATEMENT_TIMEOUT_MS`  | `notify` / `10` / `30000`                                |                                                                              |
| `DB_MIGRATE_ON_BOOT`                                                       | `true`                                                   | or `pnpm migrate`                                                            |
| `NATS_URL` / `NATS_DURABLE_PREFIX`                                         | `nats://localhost:4222` / —                              | comma separated list allowed                                                 |
| `REDIS_URL`                                                                | `redis://localhost:6379`                                 | base variable, unused (no Valkey here)                                       |
| `AUTH_JWKS_URL` / `AUTH_ISSUER` / `AUTH_AUDIENCE`                          | auth `:3001` JWKS / `ais-its-auth` / `ais-its-api`       | access tokens of HTTP and the socket.io handshake                            |
| `AUTH_INTERNAL_URL` / `INTERNAL_TOKEN`                                     | `http://localhost:3001` / dev token                      | base variables (no API-key routes here)                                      |
| `CORS_ORIGINS`                                                             | `http://localhost:5173,http://localhost:8000`            | HTTP and socket.io origins                                                   |
| `PUBLIC_BASE_URL`                                                          | `http://localhost:8000`                                  | links in notifications: `<base>/alerts?alert=<id>`                           |
| `TRUSTED_PROXIES`                                                          | loopback, link-local, private networks                   | production: the gateway's address/CIDR only (boot warning while default)     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                              | —                                                        | traces (OTLP/HTTP) when set                                                  |
| `SMTP_URL`                                                                 | `smtp://localhost:1025`                                  | Mailpit in development; `smtps://user:pass@host:465`                         |
| `SMTP_FROM`                                                                | `AIS Maritime Intelligence <no-reply@ais-its.local>`     |                                                                              |
| `SMTP_TIMEOUT_MS`                                                          | `30000`                                                  | connection, greeting and socket timeout; the claim of an exchange is 4 ×     |
| `TELEGRAM_BOT_TOKEN`                                                       | —                                                        | Telegram channel disabled while unset (`422 CHANNEL_NOT_CONFIGURED`)         |
| `TELEGRAM_API_BASE` / `TELEGRAM_TIMEOUT_MS`                                | `https://api.telegram.org` / `10000`                     | a fake API in tests                                                          |
| `WEBHOOK_SIGNING_SECRET`                                                   | —                                                        | ≥ 16 characters; signs only webhooks from before 0.2.0 (key id `deployment`) |
| `WEBHOOK_TIMEOUT_MS`                                                       | `10000`                                                  | total deadline of one attempt (response head)                                |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS`                                            | `false`                                                  | SSRF guard off (local development and tests only)                            |
| `DELIVERY_MAX_ATTEMPTS`                                                    | `6`                                                      | attempts before `failed`                                                     |
| `DELIVERY_RETRY_BASE_MS` / `DELIVERY_RETRY_MAX_MS`                         | `30000` / `3600000`                                      | backoff `base × 2^(n − 1)`, capped                                           |
| `DELIVERY_POLL_INTERVAL_MS` / `DELIVERY_CONCURRENCY` / `DELIVERY_LEASE_MS` | `1000` / `20` / `120000`                                 | polling, attempts in flight per instance, lease (≥ 2 × longest timeout)      |
| `REALTIME_TILE_BATCH_INTERVAL_MS` / `REALTIME_ALL_TILES_BATCH_INTERVAL_MS` | `1000` / `5000`                                          | batch windows (spec §9)                                                      |
| `REALTIME_MAX_VESSELS`                                                     | `200000`                                                 | live vessel state kept in memory (LRU)                                       |
| `REALTIME_MAX_VESSEL_SUBSCRIPTIONS`                                        | `100`                                                    | `vessel:<mmsi>` rooms per connection                                         |
| `REALTIME_REAUTH_ON_TOKEN_EXPIRY`                                          | `true`                                                   | close the transport at token expiry (+30 s tolerance)                        |
| `ALERT_EXPORT_MAX_ROWS`                                                    | `100000`                                                 | rows of one CSV export (1 … 1 000 000); more → `X-Truncated: true`           |
| `IDEMPOTENCY_RETENTION_DAYS`                                               | `90`                                                     | processed alert and resolution envelope ids                                  |
| `NOTIFICATION_LOG_RETENTION_DAYS`                                          | `180`                                                    | finished deliveries and e-mail log                                           |

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*`
packages come from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository):

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
pnpm install
cp .env.example .env                    # add TELEGRAM_BOT_TOKEN to try Telegram (webhooks need nothing)
pnpm --dir <central repo> infra:up      # postgres, nats, mailpit, … (or any reachable instances)
pnpm dev                                # watch mode (SWC, decorator metadata)
curl -s localhost:3008/health/ready
open http://localhost:3008/docs         # Swagger UI
open http://localhost:8025              # Mailpit: every e-mail sent in development
```

Try the realtime gateway with any socket.io 4 client:

```ts
import { io } from 'socket.io-client';
const socket = io('http://localhost:3008', {
  path: '/ws',
  auth: { token: accessToken },
});
socket.on('connect_error', (error) => console.log(error.data)); // { code: 'UNAUTHORIZED', … }
socket.emit(
  'viewport:set',
  { bbox: [104, 0.8, 105, 1.5], zoom: 9 },
  console.log,
);
socket.on('positions', (batch) => console.log(batch.items.length));
```

## Testing

```bash
pnpm test        # unit tests (no Docker)
pnpm test:int    # integration tests (Docker)
pnpm lint && pnpm typecheck && pnpm format:check
pnpm openapi     # regenerate openapi.json (no infrastructure needed); CI runs openapi:check
```

- **Unit** (`src/**/*.spec.ts`): rule matching, merge / lifecycle, detector resolutions
  (`resolveByDetector`: later occurrence, acknowledged, exact time), localizable texts
  (`localizableTextOf`), CSV cells / `Accept-Language` / `Vary`, series buckets clipped to the
  range (`assembleSeries`), the delivery summary, the
  `notify.*` ids being catalogued, quiet period, retry backoff,
  webhook signature (golden HMAC computed with OpenSSL), viewport rooms, the batcher and live
  state (no sockets), alert texts, template rendering and escaping (`id` / `en`), Telegram
  formatting limits, SSRF target checks, the gateway handshake and rooms (room changes sent back
  to back stay in order), the delivery worker's slot pool (a slow attempt never holds the others),
  the e-mail service (claim before SMTP, an accepted e-mail is never sent again when recording it
  fails), rule scopes (`all` only for authority organizations) and `null` in rule bodies.
- **Integration** (`test/*.int.test.ts`): the real `AppModule` against containers started once by
  `test/support/global-setup.ts` (kit `startTestInfra`: `timescale/timescaledb-ha:pg17`, NATS 2.11
  with `max_payload` 4 MB, Mailpit), signed test JWTs, local fake HTTP servers; event payloads come
  from the kit's `makeTestAlertRaised` / `makeTestAlertResolved` / `makeTestVesselSnapshot`:
  - `resolution-order`: a resolution handled before its raise (the raise nak'd and redelivered
    after it, an escalation likewise, a raise still uncommitted on another instance) waits and
    then resolves the alert, without a second alert; on its last delivery it is applied to what
    is there;
  - `resolutions` (two instances sharing the durable consumers): a raise then its resolution
    resolves the inbox alert once (resolved by the system at `resolvedAt`, reason / event id /
    texts in `GET /alerts/:id`, no delivery, a duplicate delivery is a no-op, the next raise opens
    a new alert); a resolution older than a merged occurrence is ignored, a later one resolves;
    `alert:updated` of a REST acknowledgement (bodiless JSON `POST`) and of a resolution reaches
    sockets on the other instance;
  - `inbox-api`: occurrence history (cursor, invalid keys → `null` texts, tenancy), read marks
    (per user, never backwards, unread again after a merge, bodiless `POST`), series (WIB days,
    empty buckets, tenancy, first and last bucket clipped to the range with totals matching
    `GET /alerts`, the cap counted on the buckets returned, invalid `tz` / bucket count), CSV export (headers by language, formula
    cells, filters validated, the row limit with `X-Truncated`);
  - `webhook-keys`: a key per webhook channel shown once, `PATCH` keeps / adds / drops keys,
    rotation (new key signs deliveries, 404 / 422 / 400 / 403), channels from before 0.2.0 signed
    with the deployment secret until rotated, the delivery summary (tenancy, period, 400, 403);
  - `alerts`: alert events → stored / merged alerts → deliveries — e-mail asserted through the
    Mailpit HTTP API, webhook through a local server verifying the signature (and a retry after a
    503), Telegram through a fake Bot API (`TELEGRAM_API_BASE`); quiet period vs escalation,
    redelivery idempotency, authority vs foreign-organization rules, permanent failures; a merge
    into an unresolved alert whose chunk is compressed (and its resolve), a resolve racing a
    merge, slow (stalling / dripping) webhook receivers that do not delay other tenants; webhook
    signatures verified with the channel's own key and `X-AIS-ITS-Key-Id`;
  - `email`: the `NOTIFY` consumer sending a password reset (escaped, localized), an invitation,
    idempotency, two concurrent copies of one request sent once, terminated invalid requests, and
    lost alert e-mails queued again (and expired ones failed);
  - `rest`: tenancy of alerts (own / related vessel, authority, no organization), filters and
    cursors, ack / resolve, rules tenancy and scopes (a `super_admin` rule for a shipping company
    stays `org`; only authority members change `all` rules), `PATCH` with `null` → 400, channel
    validation, test notifications (throwaway key for a new target, the channel key otherwise);
  - `fleet`: deletion tombstones (an upsert redelivered after the delete is ignored, a new vessel
    can take the MMSI over, a deletion before any snapshot);
  - `realtime`: socket.io end to end with `socket.io-client` — bad tokens refused, viewport
    `positions` and `safety:states` batches for events published to NATS, `tile:all` (and leaving
    it when viewports are sent back to back), vessel room updates, alerts only to `authority` and
    the owner organization (after a change of owner, updates to the new owner only),
    `cii:updated` to the organization;
  - `app`: health, migrations, 401, methodology, OpenAPI, metrics.

## Operations

- **Image** `ghcr.io/darmawanweb/ais-its-notification-service` (CI pushes `main` and
  `sha-<commit>`, releases push `<version>`, `<major>.<minor>` and `latest`). Local build:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-notification-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle secret (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-notification-service .
  ```

  Non-root (`node`), `NODE_ENV=production`, `HEALTHCHECK` on `/health/live`, `CMD node dist/main.js`.

- **Rollout order (kit 0.3 / contracts 0.4)**: deploy this version **before** safety and
  surveillance 0.2: they publish `alert.resolved.v1`, which an older notification acknowledges and
  skips (those resolutions would never close inbox alerts). Migration `0003` only adds nullable
  columns and new tables. While 0.1 and 0.2 replicas run side by side:
  - the alert fan-out interoperates (subject and payload unchanged); a 0.1 replica skips the
    resolutions it consumes;
  - **webhooks**: replicas share the deliveries, so a 0.1 worker may claim a delivery of a channel
    created or rotated on 0.2. It signs with `WEBHOOK_SIGNING_SECRET` and sends no
    `X-AIS-ITS-Key-Id`: a receiver set up with the channel's own secret rejects it, and 0.1 fails
    any 4xx other than 408 / 429 for good; without that secret it fails the delivery at once
    (`Webhooks are not configured`). Rules written through a 0.1 replica get no channel key
    (signed with the deployment secret, key id `deployment`, until rotated). Keep
    `WEBHOOK_SIGNING_SECRET` set until no 0.1 replica is left, and finish the rollout (or drain the
    0.1 replicas) before tenants create or rotate webhook channels, or deploy this version with a
    `Recreate` strategy;
  - **new routes** exist on 0.2 only: on a 0.1 replica `GET /alerts/unread-count` and
    `GET /alerts/export.csv` match `GET /alerts/:id` and answer `400` (not a UUID); the other new
    routes (`GET /alerts/stats/series`, `GET /alerts/:id/occurrences`, `POST /alerts/read`,
    `GET /notifications/deliveries/summary`, `POST /alert-rules/:id/channels/:index/rotate-secret`)
    answer `404`. Clients may see these until the rollout is complete.
- **Production settings**: `TRUSTED_PROXIES` = the gateway's address or CIDR (the kit warns at
  boot while the private-network default is in effect); the NATS server's `max_payload` ≥ 4 MB
  (the kit warns at connect otherwise).
- **Health**: `/health/live` (process), `/health/ready` (database, NATS consumers; `503` while
  shutting down). Scale horizontally: durable consumers and the delivery worker share the work,
  every instance serves its own socket.io clients (sticky sessions are only needed for the
  long-polling transport; WebSocket-only clients need none).
- **Metrics** (`/metrics`, prefix `aisits_`): `aisits_ws_connections` (gauge),
  `aisits_ws_handshakes_total{outcome}`, `aisits_ws_messages_total{event}`,
  `aisits_notifications_sent_total{channel,outcome}` (`sent`, `queued`, `retry`, `failed`),
  `aisits_alerts_ingested_total{outcome}` (`raised`, `merged`, `escalated`, `duplicate`),
  `aisits_alert_resolutions_total{outcome}` (`resolved`, `not_found`, `later_occurrence`,
  `duplicate`),
  `aisits_emails_total{template,outcome}`, plus the kit's HTTP and event metrics
  (`aisits_events_consumed_total{stream,consumer,outcome}`,
  `aisits_core_messages_total{subscription,outcome}` of the fan-out, …).
- **Troubleshooting**:
  - _No e-mails_: check `SMTP_URL` and `aisits_emails_total{outcome="retry"}`; the `email_log`
    row has the last SMTP error; after 10 deliveries the request is dead-lettered to
    `dlq.NOTIFY.notification-email` and the alert delivery marked `failed`.
  - _Deliveries stay `pending`_: look at `deliveries.error` / `next_attempt_at`
    (`GET /api/v2/notifications/deliveries?status=pending`); `CHANNEL_NOT_CONFIGURED` means the
    bot token is missing on this deployment; `no signing key` means a webhook channel from before
    0.2.0 without `WEBHOOK_SIGNING_SECRET`: rotate its secret; `Webhook unreachable: ETIMEDOUT`
    means the receiver did not answer within `WEBHOOK_TIMEOUT_MS` (it holds one of the
    `DELIVERY_CONCURRENCY` slots at most that long, other deliveries go on).
  - _Alert e-mails stay `queued`_: the hourly housekeeping queues an alert e-mail again when its
    NOTIFY request shows no progress for an hour (lost, e.g. a purged stream); the consumer
    claims each request before sending, so it is sent once. After the NOTIFY max age (7 days) the
    delivery is failed (`The e-mail request was lost …`). Log line
    `Queued lost alert e-mails again` counts both.
  - _`E-mail sent but not recorded`_ (error log): SMTP accepted the e-mail but the database
    failed; the request is redelivered for the bookkeeping only and is not sent again by this
    instance (a crash in that window can resend once from another instance).
  - _A merge waits or retries_ (`Alert changed during a merge, merging again`, debug): an
    acknowledge or resolve changed the alert between the merge's read and its update; the
    occurrence is applied again (resolved: a new alert). Merges never lock rows, so alerts in
    compressed chunks (older than 90 days) merge like recent ones.
  - _Inbox alerts stay open after the condition ended_: the detector publishes the resolution only
    after its alert cooldown since the last raise (and not at all for an occurrence another
    writer ended). A resolution handled before the raise it names waits for it (warning
    `Handler failed for …, retrying in … ms: Raise <alertId> of <dedupKey> is not stored yet;
resolution <id> waits for it`): normal after a redelivered raise or while replicas catch up
    on a backlog. When the raise is still missing at the resolution's last delivery (about 4
    minutes; the raise was dead-lettered or keeps failing), the resolution is applied to the inbox
    as it is (warning `Applying an alert resolution whose raise is not stored after its retries`)
    and a raise stored later stays open: resolve it by hand.
    `aisits_alert_resolutions_total{outcome="not_found"}` counts resolutions applied without an
    unresolved alert (resolved by a user already, or after that warning), `later_occurrence` those
    older than a merged re-raise (the newer occurrence's resolution closes it). Producers older
    than kit 0.3 publish no resolutions.
  - _Receivers reject signatures_: they must pick the secret by `X-AIS-ITS-Key-Id`; after a
    rotation the old secret no longer signs anything.
  - _Webhook refused as private_: targets on loopback/private networks need
    `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (never in production).
  - _Realtime clients get `UNAUTHORIZED`_: the token expired (clients must reconnect with a fresh
    one) or `AUTH_JWKS_URL` / issuer / audience differ from auth; `SERVICE_UNAVAILABLE` means the
    JWKS cannot be fetched.
  - _No positions on the map_: the viewport must be set after (re)connecting; check
    `aisits_events_consumed_total{consumer="notification-positions"}` and that the AIS pipeline
    publishes `AIS_POSITION`.
- **Known limitations** (accepted by design):
  - Alert pushes between instances use core NATS (best effort): an instance briefly cut off from
    NATS misses those pushes; the inbox stays authoritative and clients refresh it from REST when
    they reconnect.
  - The test-notification throttle (10 per user per 10 min) is per instance: the service uses no
    Valkey, and the endpoint needs `alert_rule:write` and validated targets.
  - `tile:all` batches carry the latest position of every vessel that reported in the 5 s window
    (spec §9); continental viewports of busy areas get large batches (no paging or compression).
  - A recurrence after a resolve (by a user or the detector) is a new alert and is notified again
    (spec §13.9 merges only while unresolved; detectors damp flapping with their cooldown and
    cancel a pending resolution on a re-raise).
  - A resolution published before this version was deployed was skipped and never closes its
    alert; resolve such alerts by hand.
  - A resolution waits for its raise only for its retries (10 deliveries, about 4 minutes): a raise
    stored later (dead-lettered and replayed, or failing for longer) opens an alert that stays
    open. Raises of producers that use other envelope ids than the alert id (kit producers do
    not) are found as the alert's first raise only, so their resolutions of merged occurrences
    wait out the retries.
  - Read marks compare with `updated_at` (the database time of the change): a change committed a
    few milliseconds after a concurrent `POST /alerts/read` may count as read.
  - Webhook secrets are stored in clear (`webhook_keys.secret`, needed for the HMAC); database
    access reveals them, like the targets. A rotation has no grace period: the old secret stops
    signing at once.
  - The occurrence history starts with 0.2.0 and holds what the detectors publish (raises and
    escalations, no de-escalations).
  - Visibility follows the current `FLEET` projection (spec §8.5), and so do the pushes: when a
    vessel changes owner its past alerts move with it (updates are pushed to the new owner only);
    a deleted vessel's alerts stay visible to `authority` and `super_admin` only. `alerts.org_id`
    keeps the owner at ingest time for reference.
  - E-mail is at-least-once across a crash between the SMTP acceptance and its bookkeeping (the
    redelivered request may be sent again by another instance once its claim expired).
- **Release**: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new
  version, bump `package.json`, regenerate `openapi.json`, tag `v<version>`.

## Legacy parity

The MVP (`/home/user/seemp-ref/be-legacy`, `fe-legacy`) had none of this service's features, so
there is no numerical parity to keep:

- **No alert inbox or deliveries.** EWS and navstatus-anomaly "alerts" were computed in the
  browser (`fe-legacy/src/pages/ews/components/ews-card.tsx: allAlerts`) and only shown in the
  page; nothing was stored, acknowledged or sent. v2 persists detector alerts (spec §15 item 7) and
  adds rules with e-mail / Telegram / webhook delivery.
- **No e-mail.** The legacy backend sent no e-mail (no password reset); v2 adds the `NOTIFY`
  pipeline for auth's resets and invitations.
- **No realtime push to the UI.** The legacy socket.io server (`be-legacy/src/config/ws-server.ts`)
  only _received_ AIS data from pushers (`ais:data`; its `joinRoom` handler was unused) — that role
  moved to the ais-pipeline ingestor. The legacy frontend polled REST endpoints every 0.1–10 s
  (`fe-legacy/src/pages/cii-page/index.tsx`, `telemetry-page`, `seemp-page`); v2 pushes batched
  deltas per map tile instead.

## Methodology & references

This service implements no formula of the methodology catalog: the alerts it stores, notifies and
pushes carry the `methodId` of the detector rule that raised them (shown in every notification with
its catalog name), for example
[`ews.pipeline_distance_status`](../../docs/METHODOLOGY.md#ews.pipeline_distance_status),
[`collision.cpa_tcpa`](../../docs/METHODOLOGY.md#collision.cpa_tcpa),
[`geo.geofence_enter`](../../docs/METHODOLOGY.md#geo.geofence_enter),
[`dark.ais_gap`](../../docs/METHODOLOGY.md#dark.ais_gap),
[`anomaly.navstatus_mismatch`](../../docs/METHODOLOGY.md#anomaly.navstatus_mismatch) and
[`fishing.loitering`](../../docs/METHODOLOGY.md#fishing.loitering) (index:
[METHODOLOGY.md §1.4](../../docs/METHODOLOGY.md#14-indeks-metode)).

Its own rules are the catalogued `notify.*` methods (domain `notification`, contracts 0.4.0),
traceable through `@method` tags and listed with their catalog entries by
`GET /api/v2/notifications/methodology`:

| Method id                        | Function                                                                              | Rule and source                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify.alert_dedup_merge`       | `mergeOccurrence` (`src/domain/alert-inbox.ts`)                                       | same `dedup_key` while unresolved → `occurrences++`, severity = max, details of the newest occurrence, escalation reopens an acknowledged alert — spec §13.9               |
| `notify.alert_lifecycle`         | `transitionAlert`, `resolveByDetector` (`src/domain/alert-inbox.ts`)                  | open → acknowledged → resolved, idempotent, resolved cannot be acknowledged; `alert.resolved.v1` resolves unless a later occurrence merged — spec §13.9, §18               |
| `notify.alert_rule_matching`     | `ruleMatchesAlert` (`src/domain/alert-rules.ts`)                                      | type / domain, severity ≥ min, vessel or related vessel, zone, organization (scope `all` for authority organizations) — spec §13.9, §8.5                                   |
| `notify.rule_quiet_period`       | `isWithinQuietPeriod` (`src/domain/alert-rules.ts`)                                   | no repeat of the same alert within `quiet_minutes` unless escalated — spec §13.9                                                                                           |
| `notify.delivery_retry_backoff`  | `retryDelayMs`, `planRetry` (`src/domain/delivery-retry.ts`)                          | `base × 2^(n − 1)` capped, honours `Retry-After`; permanent failures stop — spec §13.9                                                                                     |
| `notify.webhook_signature`       | `signWebhookPayload` (`src/domain/webhook-signature.ts`)                              | HMAC-SHA256 over `<timestamp>.<raw body>` — spec §13.9, [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104), [FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) |
| `notify.realtime_viewport_rooms` | `planViewport` (`src/domain/realtime/viewport.ts`)                                    | zoom-6 slippy-map tiles of the box, `tile:all` beyond 64 tiles — spec §9, [OSM slippy map tilenames](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames)             |
| `notify.realtime_batching`       | `RealtimeBatcher`, `LatestPerVesselBatch` (`src/domain/realtime/realtime-batcher.ts`) | latest item per vessel per room and window, 1 s tiles / 5 s `tile:all` — spec §9                                                                                           |

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
