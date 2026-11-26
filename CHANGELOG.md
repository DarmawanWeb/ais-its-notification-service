# Changelog

All notable changes to `ais-its-notification-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-23

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0 (the
local workarounds give way to the kit), inbox alerts resolved by their detectors
(`alert.resolved.v1`), the web app's backend gaps, and the hardening after the 0.1.0 review.
**Deploy before safety and surveillance 0.2** (they publish `alert.resolved.v1`; 0.1 skips it).

**Rolling update from 0.1**: replicas share the alert deliveries, and a 0.1 worker signs a
delivery of a webhook channel created or rotated on 0.2 with `WEBHOOK_SIGNING_SECRET` and no
`X-AIS-ITS-Key-Id` (a receiver set up with the channel's own secret rejects it, and 0.1 fails a
4xx for good; without that secret 0.1 fails the delivery at once with `Webhooks are not
configured`), and rules written through 0.1 get no channel key. Keep `WEBHOOK_SIGNING_SECRET` set
until no 0.1 replica is left, and finish the rollout (or drain 0.1) before tenants create or
rotate webhook channels, or use a `Recreate` rollout. Until then, 0.1 replicas answer the new
routes with `400` (`GET /alerts/unread-count`, `GET /alerts/export.csv`, matched as
`GET /alerts/:id`) or `404` (the others).

### Added

- **Detector resolutions**: the `notification-alerts` consumer handles `alert.resolved.v1` (same
  durable and subject as the raise): the unresolved (open or acknowledged) alert of the
  `dedupKey` is resolved by the system (`resolved_by` `NULL`, `resolved_at` = `resolvedAt`,
  reason, event id and data kept) and leaves `open_alerts`, unless it merged an occurrence later
  than `resolvedAt`; idempotent by envelope id, no rule deliveries, `alert:updated` through the
  fan-out to the vessels' current owners. The kit does not keep raise → resolve order (a nak'd
  raise is redelivered after later messages of its subject; replicas handle both at once), so a
  resolution whose raise (`alertId`) is not stored yet fails retryably until it is (no `not_found`
  for an occurrence still on its way, no new alert left open by a late escalation) and is applied
  to what is there on its last delivery. Pure rule `resolveByDetector` (`notify.alert_lifecycle`);
  metric `aisits_alert_resolutions_total{outcome}`.
- `AlertDto`: `messageKey` / `messageParams` (platform convention: read from `data` and
  validated, otherwise `null`), `resolutionReason`, `resolutionMessageKey`,
  `resolutionMessageParams`, `resolutionEventId`.
- `GET /api/v2/alerts/:id/occurrences`: the occurrence history (every stored `alert.raised.v1`
  with its own severity, texts and data; cursor pages, newest first).
- `GET /api/v2/alerts/unread-count` and `POST /api/v2/alerts/read { upTo? }`: a read mark per user
  and active organization (only moves forward; bodiless requests allowed).
- `GET /api/v2/alerts/stats/series?from&to&bucket=1h|1d&groupBy=severity|type|domain&tz`: counts
  per local hour or day of the first occurrence with the filters and tenancy of the inbox, empty
  buckets included; the first bucket starts at `from` and the last ends at `to` (inclusive), so
  partial buckets count only their part of the range and the totals match `GET /alerts`; at most
  1 000 buckets as returned (`400` beyond).
- `GET /api/v2/alerts/export.csv`: the filters of `GET /alerts` as streamed CSV, headers in `id` /
  `en` by `Accept-Language`, formula cells neutralized, at most `ALERT_EXPORT_MAX_ROWS` (default
  100 000) rows with `X-Truncated: true` beyond; `Content-Disposition`, `Content-Language` and
  `X-Truncated` exposed by CORS.
- **Per-channel webhook signing keys**: every webhook channel gets its own secret, shown once in the
  `POST` / `PATCH` response (`channels[i].signingSecret`, `keyId` always), `POST
/api/v2/alert-rules/:id/channels/:index/rotate-secret` (404 `RULE_CHANNEL_NOT_FOUND`, 422
  `RULE_CHANNEL_NOT_WEBHOOK`) and the header `X-AIS-ITS-Key-Id`; test notifications report their
  `keyId` (a throwaway `test` key for targets that are no channel yet).
- `GET /api/v2/notifications/deliveries/summary?ruleId&from&to`: `{ sent, failed, pending, queued,
total, lastDeliveredAt, successRate }` of the organization's rules (default 30 days).
- Migration `0003_resolutions_history_read_keys`: `alerts.resolution_reason`,
  `resolution_event_id`, `resolution_data`; hypertable `alert_occurrences` (retention 2 years);
  tables `alert_read_marks` and `webhook_keys`.
- Tests: two-instance resolutions and fan-out (`test/resolutions.int.test.ts`), inbox API
  (`test/inbox-api.int.test.ts`), webhook keys and the delivery summary
  (`test/webhook-keys.int.test.ts`); unit tests of the resolution rule, localizable texts, CSV and
  `Accept-Language` helpers, the summary and the catalogued method ids.
- Migration `0002_review_hardening`: table `open_alerts` (the unresolved alert of each dedup key),
  tombstones in the `vessels` projection (`deleted_at`, mmsi unique among live vessels only), the
  `sending` claim of `email_log` (`claimed_until`) and an index of queued deliveries.
- `DELIVERY_CONCURRENCY` (default 20): attempts in flight per instance; replaces
  `DELIVERY_BATCH_SIZE`. Boot refuses a `DELIVERY_LEASE_MS` shorter than twice the longest channel
  timeout.
- Hourly requeue of alert e-mails whose `NOTIFY` request was lost (queued for an hour without
  progress; failed after the 7-day NOTIFY max age), and pruning of `open_alerts` entries of alerts
  dropped by the retention policy.

### Changed

- Dependencies: contracts `^0.4.0`, kit `^0.3.0`; no direct `prom-client` (metric types from
  `@darmawanweb/ais-its-nest/metrics`); `.pnpmfile.cjs` of the template (no kit entry,
  `@nestjs/terminus` gRPC peers kept out of the production install).
- The alert fan-out uses the contracts core subscription `notification-realtime-fanout`
  (`subjects.notificationRealtime()`, `RealtimeAlertFanoutSchema`, `delivery: 'fanout'`, payload
  validated by the kit); subject and payload are unchanged, so 0.1 and 0.2 instances share the
  fan-out (webhooks and the new routes do not mix during a rolling update: see above).
- `WEBHOOK_SIGNING_SECRET` only signs webhook channels created before 0.2.0 (key id `deployment`)
  until their secret is rotated; the webhook channel no longer needs it (no more
  `CHANNEL_NOT_CONFIGURED` for webhooks).
- Kit helpers replace local ones: `@IsOptionalNotNull()`, `isUniqueViolation`, `@UuidParam()` /
  `@IntParam()` (`400 VALIDATION_FAILED` with field errors for malformed path parameters),
  `MIGRATIONS_DIR` resolved from the package (migrations found from any working directory);
  test fixtures from `@darmawanweb/ais-its-nest/testing`.
- The FLEET projection and the alerts consumer are exhaustive switches over the exact consumer
  envelopes.
- The `notify.*` method ids are catalogued (contracts 0.4.0): the methodology endpoint shows their
  catalog entries; the "proposed id" remarks are gone.
- Bodiless `POST`s with `Content-Type: application/json` (e.g. `/alerts/:id/ack`) are accepted
  (kit 0.3).
- Rule scope `all` belongs to authority organizations: the default and the right to set it come
  from the `authority` role in the rule's own organization (no longer from `super_admin`); every
  change of a rule with scope `all` needs that role or `super_admin`. Updates apply only while
  the scope they were authorized against is stored.
- The e-mail consumer handles requests concurrently (`orderBySubject: false`: every request has
  the subject `notify.email.v1`, so the kit serialized them all).
- Webhook attempts read the response status only and destroy the response at once.
- Prettier leaves embedded template languages alone (`embeddedLanguageFormatting: off`).

### Fixed

- Merges into an unresolved alert whose chunk was compressed failed for good
  (`locking compressed tuples is not supported`): the merge looks the alert up in `open_alerts`,
  reads it without `FOR UPDATE` and updates it conditionally on the status it read (an acknowledge
  or resolve in between makes it merge again; resolved → new alert).
- `WEBHOOK_TIMEOUT_MS` was a socket idle timeout: a dripping receiver held an attempt — and, with
  the per-batch `Promise.all`, every other delivery of the instance — indefinitely. Attempts now
  have a total deadline and run in a refilling pool of slots.
- A `super_admin` creating a rule for a shipping company got scope `all` (cross-tenant alert
  content to that company's channels), and members could redirect the channels of an `all` rule.
- An accepted e-mail was sent again on every redelivery when recording it failed (database
  errors were reported as SMTP errors): the SMTP exchange and the bookkeeping are separate steps,
  the bookkeeping (log row + alert delivery in one transaction) is retried without sending again.
- Two `viewport:set` sent back to back planned from the same rooms and left the client in
  `tile:all` for good: room changes of a connection run in order and read `socket.rooms`.
- `PATCH /alert-rules/:id` with `null` fields answered `500 INTERNAL_ERROR`; it is
  `400 VALIDATION_FAILED` (also `null` in a new rule or a test notification).
- A `fleet.vessel.upserted.v1` redelivered after the vessel's deletion re-inserted the deleted
  vessel for good (its former owner kept seeing its alerts and matching rules).
- Removed the stale `@types/nodemailer` (8.x): nodemailer 10 ships its own types.
- Acknowledge and resolve over REST pushed `alert:updated` to the organization that owned the
  vessel when the alert was stored, also after the vessel changed owner (that organization can no
  longer read the alert): pushes go to the current owners only, as the alert is read.

### Removed

- Local workarounds now in the kit or contracts: `src/db/errors.ts` (and its spec), the local
  `REALTIME_FANOUT_SUBSCRIPTION` / `FanoutMessageSchema` with `queue: false`, the `event.type`
  if/else chain of the FLEET projection, the local alert fixture.

## [0.1.0] - 2026-11-21

### Added

- Service generated from the platform template (`templates/nest-service`): configuration, health,
  metrics, OpenAPI, authentication (default deny), migrations, CI, Docker image.
- Alert inbox (spec §13.9): durable consumer `notification-alerts` on `ALERTS`, `alerts` hypertable
  (compression after 90 days, retention 2 years), merge of occurrences with the same `dedup_key`
  while unresolved (`occurrences`, severity escalation, reopening of acknowledged alerts),
  idempotent by envelope id; `GET /api/v2/alerts`, `/alerts/summary`, `/alerts/:id`,
  `POST /alerts/:id/ack`, `/alerts/:id/resolve` with the tenancy of spec §8.5 and audit events.
- Alert rules (`/api/v2/alert-rules`, tenant-private): type / domain, minimum severity, vessels,
  zones, organization scope (`all` for authority principals), per-rule quiet period, locale.
- Deliveries with exponential retries over e-mail (via `NOTIFY`), Telegram Bot API
  (`TELEGRAM_API_BASE`) and webhooks signed with `X-AIS-ITS-Signature` / `X-AIS-ITS-Timestamp`
  (SSRF guard); `POST /api/v2/notifications/test` and `GET /api/v2/notifications/deliveries`.
- Transactional e-mail: durable consumer `notification-email` on `NOTIFY`, templates
  `password_reset`, `account_invite`, `alert`, `test` in `id` and `en` with HTML escaping, SMTP via
  nodemailer, `email_log`.
- `FLEET` projection (`notification-fleet`): mmsi → owner organization.
- Realtime gateway (spec §9): socket.io at `/ws` on the HTTP port, handshake JWT verification,
  user / org / authority rooms, `viewport:set` (zoom-6 tile rooms, `tile:all` beyond 64 tiles),
  vessel rooms, per-instance ordered consumers on `AIS_POSITION`, `SAFETY` (`last_per_subject`) and
  `EMISSION`, `positions` / `safety:states` batches (1 s, `tile:all` 5 s), immediate
  `vessel:position` / `vessel:safety`, `alert:raised` / `alert:updated`, `cii:updated`, alert
  fan-out across instances.
- Metrics `aisits_ws_connections`, `aisits_notifications_sent_total{channel,outcome}` and
  ingestion, e-mail and realtime counters; `GET /api/v2/notifications/methodology`.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-notification-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-notification-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-notification-service/releases/tag/v0.1.0
