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
  unresolved alert (`occurrences++`, severity escalation). Users list, acknowledge and resolve
  alerts with the tenancy of spec §8.5.
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
    FAN{{core: aisits.notification.realtime.v1}}
  end

  subgraph svc["notification (one or more instances)"]
    AC["AlertsConsumer<br/>durable notification-alerts"]
    ING["AlertIngestService<br/>merge (dedup_key) + plan deliveries<br/>one transaction"]
    DW["DeliveryWorker<br/>FOR UPDATE SKIP LOCKED, leases, backoff"]
    EC["EmailConsumer<br/>durable notification-email"]
    FP["FleetProjection<br/>durable notification-fleet"]
    RS["RealtimeStreams<br/>ordered consumers (per instance)"]
    HUB["RealtimeHub<br/>VesselLiveState + RealtimeBatcher"]
    GW["RealtimeGateway<br/>socket.io /ws"]
    REST["REST /api/v2<br/>alerts, alert-rules, notifications"]
  end

  DB[("PostgreSQL schema notify<br/>alerts (hypertable), alert_rules,<br/>deliveries, email_log, vessels")]
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
  delivery worker.
- **Deliveries**: every instance polls due deliveries (`DELIVERY_POLL_INTERVAL_MS`, and at once
  when woken); claims are exclusive (`FOR UPDATE SKIP LOCKED`) and leased (`DELIVERY_LEASE_MS`), so
  instances share the work and an attempt of a crashed instance is retried after its lease.
  Failures are retried after `base × 2^(attempt − 1)` (honouring `Retry-After` / Telegram
  `retry_after`) up to `DELIVERY_MAX_ATTEMPTS`; permanent refusals (4xx, unknown chat) fail at once.
  E-mail deliveries are handed to `NOTIFY` (status `queued`); the e-mail consumer marks them
  `sent` or `failed`.
- **Realtime**: every instance runs its own ordered (ephemeral) consumers on `AIS_POSITION`
  (`new`), `SAFETY` (`last_per_subject`, warming the latest state of every vessel) and `EMISSION`
  (`new`), and pushes to its own clients. Alert pushes (from the durable consumer or a REST
  ack/resolve on _some_ instance) are fanned out to all instances through the core NATS subject
  `aisits.notification.realtime.v1` (no stream; best effort, the inbox stays the source of truth).
  The batching is a pure, socket-free component (`src/domain/realtime/realtime-batcher.ts`).

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
start consumers, timers and the gateway (`onApplicationBootstrap`) → the port opens. On `SIGTERM`
readiness turns `503`, realtime clients are disconnected (they reconnect to another instance),
consumers and NATS drain, the delivery worker finishes its attempts and the pool closes.

| Path                              | What                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/domain/`                     | pure rules with `@method` TSDoc: merge, lifecycle, matching, quiet period, retry, signature |
| `src/domain/realtime/`            | viewport rooms, latest-per-vessel batching, live vessel state (no sockets)                  |
| `src/modules/alerts/`             | `notification-alerts` consumer, ingest + delivery planner, inbox REST                       |
| `src/modules/rules/`              | alert rules CRUD (tenant-private)                                                           |
| `src/modules/deliveries/`         | delivery worker, channels (e-mail, Telegram, webhook), test notifications                   |
| `src/modules/email/`              | `notification-email` consumer, templates (`id` / `en`), SMTP mailer                         |
| `src/modules/realtime/`           | socket.io gateway, hub, ordered consumers, alert fan-out                                    |
| `src/modules/vessels/`            | `notification-fleet` projection (mmsi → owner organization)                                 |
| `src/modules/housekeeping/`       | retention of processed event ids, deliveries and the e-mail log                             |
| `src/modules/methodology/`        | `GET /api/v2/notifications/methodology`                                                     |
| `migrations/`, `src/db/schema.ts` | forward-only SQL and its drizzle mirror                                                     |
| `test/`                           | integration tests (`*.int.test.ts`) against real containers                                 |

## Data model

| Table              | Kind                                     | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts`           | hypertable on `occurred_at` (7 d chunks) | `id` (= alert / envelope id of the first occurrence), `type`, `domain`, `severity` (highest merged), `mmsi`, `related_mmsi`, `org_id` (vessel owner when stored), `title`, `message`, `lat`, `lon`, `zone_id`, `method_id`, `dedup_key`, `data`, `source`, `status` (`open` / `acknowledged` / `resolved`), `acknowledged_by/at`, `resolved_by/at`, `occurrences`, `last_occurred_at`. Compressed after 90 days (segment `mmsi`), dropped after 2 years. Partial index on `dedup_key` of unresolved alerts. |
| `alert_rules`      | table                                    | `org_id`, `created_by`, `name`, `scope` (`org` = own fleet, `all` = every vessel, authority only), `types[]`, `domains[]`, `min_severity`, `mmsi[]`, `zone_ids[]`, `channels` jsonb `[{ type, target }]` (1–10), `locale` (`id` / `en`), `quiet_minutes`, `enabled`. Empty lists match everything.                                                                                                                                                                                                          |
| `deliveries`       | table                                    | `alert_id`, `rule_id` (cascade), `channel`, `target`, `severity` (when planned), `status` (`pending` → `sending` → `sent` / `failed`; e-mail `sending` → `queued` → `sent` / `failed`), `attempts`, `error`, `payload` (alert as pushed, rule and vessel names, locale, link), `next_attempt_at`, `lease_until`, `sent_at`.                                                                                                                                                                                 |
| `email_log`        | table                                    | one row per `notify.email.requested.v1` envelope (idempotency key): recipient, template, locale, subject, source, `delivery_id`, `status` (`retrying` / `sent` / `failed`), `attempts`, `error`, SMTP `message_id`. Bodies are never stored (reset links).                                                                                                                                                                                                                                                  |
| `vessels`          | projection of `FLEET`                    | `vessel_id`, `mmsi` (unique), `org_id`, `name`, `updated_at` — a snapshot never overwrites a newer one.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `processed_events` | idempotency                              | `(consumer, event_id)` of handled alert envelopes, kept `IDEMPOTENCY_RETENTION_DAYS` (≥ the 90 days of `ALERTS`).                                                                                                                                                                                                                                                                                                                                                                                           |

Finished deliveries and e-mail log rows are pruned after `NOTIFICATION_LOG_RETENTION_DAYS` by the
hourly housekeeping job.

## API

All routes under `/api/v2` (gateway prefixes `/api/v2/alerts`, `/api/v2/alert-rules`,
`/api/v2/notifications`, `/ws` → this service, spec §12). Lists follow spec §5 (cursor pages for
alerts and deliveries, page-based for rules); errors are RFC 9457 problem details. The OpenAPI
document is [`openapi.json`](openapi.json) (`pnpm openapi`), served at `/openapi.json` and `/docs`.

| Method   | Path                         | Permission         | What                                                                                                |
| -------- | ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `GET`    | `/alerts`                    | `alert:read`       | `status, type, domain, severity, mmsi, from, to, cursor, limit` — newest first                      |
| `GET`    | `/alerts/summary`            | `alert:read`       | open alerts by severity, domain and type (every registry type, 0 when none)                         |
| `GET`    | `/alerts/:id`                | `alert:read`       | one alert (`404 ALERT_NOT_FOUND` also for other tenants' alerts)                                    |
| `POST`   | `/alerts/:id/ack`            | `alert:ack`        | open → acknowledged (idempotent; `409 ALERT_ALREADY_RESOLVED`); pushes `alert:updated`              |
| `POST`   | `/alerts/:id/resolve`        | `alert:ack`        | → resolved (idempotent); pushes `alert:updated`                                                     |
| `GET`    | `/alert-rules`               | `alert_rule:write` | rules of the active organization (`super_admin`: all, `orgId` filter), `page, pageSize, enabled`    |
| `POST`   | `/alert-rules`               | `alert_rule:write` | create in the active organization (`super_admin` may set `orgId`)                                   |
| `GET`    | `/alert-rules/:id`           | `alert_rule:write` | one rule                                                                                            |
| `PATCH`  | `/alert-rules/:id`           | `alert_rule:write` | change (the organization cannot change)                                                             |
| `DELETE` | `/alert-rules/:id`           | `alert_rule:write` | delete with its delivery history                                                                    |
| `POST`   | `/notifications/test`        | `alert_rule:write` | `{ channel, target, locale? }` — Telegram / webhook sent at once, e-mail queued; 10 / user / 10 min |
| `GET`    | `/notifications/deliveries`  | `alert_rule:write` | delivery log of the organization's rules: `ruleId, alertId, status, cursor, limit`                  |
| `GET`    | `/notifications/methodology` | signed-in user     | methods implemented here (spec §17)                                                                 |

Outside the prefix: `GET /health/live`, `GET /health/ready`, `GET /metrics`, `GET /docs`,
`GET /openapi.json`, socket.io at `/ws`.

**Tenancy (spec §8.5).** `authority` and `super_admin` see every alert; other roles see the
alerts whose vessel **or related vessel** belongs to their active organization (evaluated against
the current `FLEET` projection); without an organization nothing. Rules and deliveries are
tenant-private (`super_admin` manages all). Rules of scope `all` ("authority-org rules may match
any vessel") can only be created by `authority` / `super_admin` principals (their default);
others get `403 RULE_SCOPE_FORBIDDEN`. Error codes: `ALERT_NOT_FOUND`, `ALERT_ALREADY_RESOLVED`,
`ALERT_RULE_NOT_FOUND`, `RULE_SCOPE_FORBIDDEN`, `ORGANIZATION_REQUIRED`,
`CHANNEL_NOT_CONFIGURED` (422: Telegram without `TELEGRAM_BOT_TOKEN`, webhook without
`WEBHOOK_SIGNING_SECRET`), `VALIDATION_FAILED`, `RATE_LIMITED`, `CONFLICT`.

### Rule matching

A rule matches an alert when **all** hold (empty lists do not restrict): enabled; scope `org` →
the alert's vessel or related vessel belongs to the rule's organization (scope `all`: any vessel);
`types` contains the type (open vocabulary: future types work); `domains` contains the domain;
severity ≥ `minSeverity` (`info < warning < critical`); `mmsi` contains the vessel or related
vessel; `zoneIds` contains the alert's zone. **Quiet period:** after a rule notified an alert, new
occurrences of the same alert are not notified again by that rule for `quietMinutes` — unless
the severity rose (escalations always notify); other alerts are never held back.

### Webhooks

`POST <target>` with `Content-Type: application/json`, no redirects followed, timeout
`WEBHOOK_TIMEOUT_MS`; 2xx = sent, 408 / 429 / 5xx / network errors are retried, other statuses
fail for good. Loopback, private and link-local targets are refused (also after DNS resolution)
unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.

| Header                | Value                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| `X-AIS-ITS-Timestamp` | signing time, Unix seconds                                                   |
| `X-AIS-ITS-Signature` | `sha256=<hex HMAC-SHA256(WEBHOOK_SIGNING_SECRET, "<timestamp>.<raw body>")>` |
| `X-AIS-ITS-Delivery`  | delivery id (deduplicate retries with it)                                    |

Body: `{ deliveryId, event: "alert.raised" | "alert.escalated" | "alert.recurred" | "test", sentAt,
locale, rule: { id, name }, vessel: { mmsi, name }, alert: RealtimeAlert, link, text }`.
Receivers recompute the HMAC over the exact raw body and reject timestamps older than a few
minutes (see `verifyWebhookSignature` in `src/domain/webhook-signature.ts`):

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
`toRealtimeSafetyState`) and alert pushes are validated with `RealtimeAlertSchema`.

## Events

| Direction | Stream / subject                            | Type                                                  | Consumer / producer                                                                          |
| --------- | ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| consumes  | `ALERTS` `alert.v1.<type>.<mmsi>`           | `alert.raised.v1`                                     | durable `notification-alerts` (concurrency 4, per-vessel order)                              |
| consumes  | `NOTIFY` `notify.email.v1` (work queue)     | `notify.email.requested.v1`                           | durable `notification-email` (concurrency 4, ack wait 60 s)                                  |
| consumes  | `FLEET` `fleet.vessel.v1.<vesselId>`        | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1` | durable `notification-fleet`                                                                 |
| consumes  | `AIS_POSITION` `ais.position.v1.<p>.<mmsi>` | `ais.position.recorded.v1`                            | ordered `notification-positions` per instance (`new`)                                        |
| consumes  | `SAFETY` `safety.state.v1.<mmsi>`           | `safety.vessel_state.updated.v1`                      | ordered `notification-safety` per instance (`last_per_subject`)                              |
| consumes  | `EMISSION` `emission.cii.v1.<mmsi>`         | `emission.cii.updated.v1`                             | ordered `notification-cii` per instance (`new`)                                              |
| produces  | `NOTIFY` `notify.email.v1`                  | `notify.email.requested.v1`                           | alert e-mails (envelope id = delivery id) and test e-mails                                   |
| produces  | `AUDIT` `audit.v1.notification`             | `audit.recorded.v1`                                   | `alert.acknowledge`, `alert.resolve`, `alert_rule.create/update/delete`, `notification.test` |
| both      | core `aisits.notification.realtime.v1`      | `{ event, rooms, alert }` (internal)                  | subscription `notification-realtime-fanout` on every instance (no queue group)               |

Streams produced to (`NOTIFY`, `AUDIT`) are created or widened on boot; consumed streams are only
created when missing. Invalid messages are terminated and counted; transient failures are retried
with backoff and dead-lettered to `dlq.<stream>.<consumer>` after 10 deliveries. Handlers are
idempotent: alerts by envelope id (`processed_events`) and per `dedupKey`, e-mails by envelope id
(`email_log`), the projection by `updatedAt`.

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
| `TRUSTED_PROXIES`                                                          | —                                                        | addresses/CIDRs whose `X-Forwarded-*` are trusted                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                              | —                                                        | traces (OTLP/HTTP) when set                                                  |
| `SMTP_URL`                                                                 | `smtp://localhost:1025`                                  | Mailpit in development; `smtps://user:pass@host:465`                         |
| `SMTP_FROM`                                                                | `AIS Maritime Intelligence <no-reply@ais-its.local>`     |                                                                              |
| `SMTP_TIMEOUT_MS`                                                          | `30000`                                                  | connection, greeting and socket timeout                                      |
| `TELEGRAM_BOT_TOKEN`                                                       | —                                                        | Telegram channel disabled while unset (`422 CHANNEL_NOT_CONFIGURED`)         |
| `TELEGRAM_API_BASE` / `TELEGRAM_TIMEOUT_MS`                                | `https://api.telegram.org` / `10000`                     | a fake API in tests                                                          |
| `WEBHOOK_SIGNING_SECRET`                                                   | —                                                        | ≥ 16 characters; webhook channel disabled while unset                        |
| `WEBHOOK_TIMEOUT_MS`                                                       | `10000`                                                  |                                                                              |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS`                                            | `false`                                                  | SSRF guard off (local development and tests only)                            |
| `DELIVERY_MAX_ATTEMPTS`                                                    | `6`                                                      | attempts before `failed`                                                     |
| `DELIVERY_RETRY_BASE_MS` / `DELIVERY_RETRY_MAX_MS`                         | `30000` / `3600000`                                      | backoff `base × 2^(n − 1)`, capped                                           |
| `DELIVERY_POLL_INTERVAL_MS` / `DELIVERY_BATCH_SIZE` / `DELIVERY_LEASE_MS`  | `1000` / `20` / `120000`                                 | worker polling, claim size, lease of a claimed delivery                      |
| `REALTIME_TILE_BATCH_INTERVAL_MS` / `REALTIME_ALL_TILES_BATCH_INTERVAL_MS` | `1000` / `5000`                                          | batch windows (spec §9)                                                      |
| `REALTIME_MAX_VESSELS`                                                     | `200000`                                                 | live vessel state kept in memory (LRU)                                       |
| `REALTIME_MAX_VESSEL_SUBSCRIPTIONS`                                        | `100`                                                    | `vessel:<mmsi>` rooms per connection                                         |
| `REALTIME_REAUTH_ON_TOKEN_EXPIRY`                                          | `true`                                                   | close the transport at token expiry (+30 s tolerance)                        |
| `IDEMPOTENCY_RETENTION_DAYS`                                               | `90`                                                     | processed alert envelope ids                                                 |
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
cp .env.example .env                    # add WEBHOOK_SIGNING_SECRET / TELEGRAM_BOT_TOKEN to try those channels
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

- **Unit** (`src/**/*.spec.ts`): rule matching, merge / lifecycle, quiet period, retry backoff,
  webhook signature (golden HMAC computed with OpenSSL), viewport rooms, the batcher and live
  state (no sockets), alert texts, template rendering and escaping (`id` / `en`), Telegram
  formatting limits, SSRF target checks, the gateway handshake and rooms.
- **Integration** (`test/*.int.test.ts`): the real `AppModule` against containers started once by
  `test/support/global-setup.ts` (`timescale/timescaledb-ha:pg17`, `nats:2.11-alpine`,
  `axllent/mailpit:latest`), signed test JWTs, local fake HTTP servers:
  - `alerts`: alert events → stored / merged alerts → deliveries — e-mail asserted through the
    Mailpit HTTP API, webhook through a local server verifying the signature (and a retry after a
    503), Telegram through a fake Bot API (`TELEGRAM_API_BASE`); quiet period vs escalation,
    redelivery idempotency, authority vs foreign-organization rules, permanent failures;
  - `email`: the `NOTIFY` consumer sending a password reset (escaped, localized), an invitation,
    idempotency and terminated invalid requests;
  - `rest`: tenancy of alerts (own / related vessel, authority, no organization), filters and
    cursors, ack / resolve, rules tenancy and scopes, channel validation, test notifications;
  - `realtime`: socket.io end to end with `socket.io-client` — bad tokens refused, viewport
    `positions` and `safety:states` batches for events published to NATS, `tile:all`, vessel room
    updates, alerts only to `authority` and the owner organization, `cii:updated` to the
    organization;
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

- **Health**: `/health/live` (process), `/health/ready` (database, NATS consumers; `503` while
  shutting down). Scale horizontally: durable consumers and the delivery worker share the work,
  every instance serves its own socket.io clients (sticky sessions are only needed for the
  long-polling transport; WebSocket-only clients need none).
- **Metrics** (`/metrics`, prefix `aisits_`): `aisits_ws_connections` (gauge),
  `aisits_ws_handshakes_total{outcome}`, `aisits_ws_messages_total{event}`,
  `aisits_notifications_sent_total{channel,outcome}` (`sent`, `queued`, `retry`, `failed`),
  `aisits_alerts_ingested_total{outcome}` (`raised`, `merged`, `escalated`, `duplicate`),
  `aisits_emails_total{template,outcome}`, plus the kit's HTTP and event metrics
  (`aisits_events_consumed_total{stream,consumer,outcome}`, …).
- **Troubleshooting**:
  - _No e-mails_: check `SMTP_URL` and `aisits_emails_total{outcome="retry"}`; the `email_log`
    row has the last SMTP error; after 10 deliveries the request is dead-lettered to
    `dlq.NOTIFY.notification-email` and the alert delivery marked `failed`.
  - _Deliveries stay `pending`_: look at `deliveries.error` / `next_attempt_at`
    (`GET /api/v2/notifications/deliveries?status=pending`); `CHANNEL_NOT_CONFIGURED` means the
    bot token or signing secret is missing on this deployment.
  - _Webhook refused as private_: targets on loopback/private networks need
    `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (never in production).
  - _Realtime clients get `UNAUTHORIZED`_: the token expired (clients must reconnect with a fresh
    one) or `AUTH_JWKS_URL` / issuer / audience differ from auth; `SERVICE_UNAVAILABLE` means the
    JWKS cannot be fetched.
  - _No positions on the map_: the viewport must be set after (re)connecting; check
    `aisits_events_consumed_total{consumer="notification-positions"}` and that the AIS pipeline
    publishes `AIS_POSITION`.
- **Release**: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new
  version, bump `package.json`, tag `v<version>`.

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

Its own rules are traceable through `@method` tags under **proposed ids that are not yet in
`docs/references/methods.json`** (listed by `GET /api/v2/notifications/methodology` without catalog
details until they are catalogued):

| Proposed method id               | Function                                                                              | Rule and source                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify.alert_dedup_merge`       | `mergeOccurrence` (`src/domain/alert-inbox.ts`)                                       | same `dedup_key` while unresolved → `occurrences++`, severity = max, details of the newest occurrence, escalation reopens an acknowledged alert — spec §13.9               |
| `notify.alert_lifecycle`         | `transitionAlert` (`src/domain/alert-inbox.ts`)                                       | open → acknowledged → resolved, idempotent, resolved cannot be acknowledged — spec §13.9                                                                                   |
| `notify.alert_rule_matching`     | `ruleMatchesAlert` (`src/domain/alert-rules.ts`)                                      | type / domain, severity ≥ min, vessel or related vessel, zone, organization (scope `all` for authority) — spec §13.9, §8.5                                                 |
| `notify.rule_quiet_period`       | `isWithinQuietPeriod` (`src/domain/alert-rules.ts`)                                   | no repeat of the same alert within `quiet_minutes` unless escalated — spec §13.9                                                                                           |
| `notify.delivery_retry_backoff`  | `retryDelayMs`, `planRetry` (`src/domain/delivery-retry.ts`)                          | `base × 2^(n − 1)` capped, honours `Retry-After`; permanent failures stop — spec §13.9                                                                                     |
| `notify.webhook_signature`       | `signWebhookPayload` (`src/domain/webhook-signature.ts`)                              | HMAC-SHA256 over `<timestamp>.<raw body>` — spec §13.9, [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104), [FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) |
| `notify.realtime_viewport_rooms` | `planViewport` (`src/domain/realtime/viewport.ts`)                                    | zoom-6 slippy-map tiles of the box, `tile:all` beyond 64 tiles — spec §9, [OSM slippy map tilenames](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames)             |
| `notify.realtime_batching`       | `RealtimeBatcher`, `LatestPerVesselBatch` (`src/domain/realtime/realtime-batcher.ts`) | latest item per vessel per room and window, 1 s tiles / 5 s `tile:all` — spec §9                                                                                           |

## Contributing

Conventional commits (commitlint), lint-staged on commit (Husky). CI runs format, lint, typecheck,
unit and integration tests, build, the `openapi.json` freshness check and the image build.
