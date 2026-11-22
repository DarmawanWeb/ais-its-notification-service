# Changelog

All notable changes to `ais-its-notification-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/DarmawanWeb/ais-its-notification-service/releases/tag/v0.1.0
