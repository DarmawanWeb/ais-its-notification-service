# Changelog

All notable changes to `ais-its-notification-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Migration `0002_review_hardening`: table `open_alerts` (the unresolved alert of each dedup key),
  tombstones in the `vessels` projection (`deleted_at`, mmsi unique among live vessels only), the
  `sending` claim of `email_log` (`claimed_until`) and an index of queued deliveries.
- `DELIVERY_CONCURRENCY` (default 20): attempts in flight per instance; replaces
  `DELIVERY_BATCH_SIZE`. Boot refuses a `DELIVERY_LEASE_MS` shorter than twice the longest channel
  timeout.
- Hourly requeue of alert e-mails whose `NOTIFY` request was lost (queued for an hour without
  progress; failed after the 7-day NOTIFY max age), and pruning of `open_alerts` entries of alerts
  dropped by the retention policy.
- `@OptionalNotNull()` for optional body fields that refuse `null`.

### Changed

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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-notification-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-notification-service/releases/tag/v0.1.0
