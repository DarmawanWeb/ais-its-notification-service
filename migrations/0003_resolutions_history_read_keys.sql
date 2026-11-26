-- 0003_resolutions_history_read_keys — detector resolutions (alert.resolved.v1,
-- contracts 0.4.0), the occurrence history of inbox alerts, per-user read
-- marks and per-channel webhook signing keys (docs/PLATFORM_SPEC.md §6, §13.9,
-- §18).
--
-- Runs inside schema "notify" (search_path=notify,public) as notify_svc, in one
-- transaction. Forward-only: never edit once applied, add 0004_<change>.sql.

-- 1. Resolutions announced by the detectors.
--
-- alert.resolved.v1 resolves the unresolved inbox alert of its dedup key with
-- resolved_by NULL (the system) and resolved_at = the event's resolvedAt. The
-- English reason, the event id and the event's data (its localizable
-- messageKey / messageParams) are kept with the alert. Nullable columns
-- without defaults: compressed chunks of the hypertable need no rewrite.
ALTER TABLE alerts ADD COLUMN resolution_reason text;
ALTER TABLE alerts ADD COLUMN resolution_event_id uuid;
ALTER TABLE alerts ADD COLUMN resolution_data jsonb;

COMMENT ON COLUMN alerts.resolution_reason IS
  'reason of the alert.resolved.v1 that resolved the alert (NULL: a user resolved it)';
COMMENT ON COLUMN alerts.resolution_event_id IS
  'Envelope id of the alert.resolved.v1 that resolved the alert';

-- 2. Occurrence history (GET /alerts/:id/occurrences).
--
-- One row per alert.raised.v1 stored in the inbox: the occurrence that opened
-- the alert and every one merged into it, with its own severity, texts and
-- measurements (the alert row keeps only the maximum severity and the newest
-- details). Partitioned by the occurred_at of the inbox alert, so the
-- occurrences of an alert sit in its chunk and are dropped with it.
CREATE TABLE alert_occurrences (
  alert_id          uuid NOT NULL,
  alert_occurred_at timestamptz NOT NULL,
  -- Envelope id of the alert.raised.v1.
  event_id          uuid NOT NULL,
  occurred_at       timestamptz NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('raised', 'merged', 'escalated')),
  severity          text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  related_mmsi      integer CHECK (related_mmsi BETWEEN 100000000 AND 999999999),
  title             text NOT NULL,
  message           text NOT NULL,
  lat               double precision CHECK (lat BETWEEN -90 AND 90),
  lon               double precision CHECK (lon BETWEEN -180 AND 180),
  zone_id           uuid,
  method_id         text NOT NULL,
  data              jsonb NOT NULL DEFAULT '{}',
  received_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, alert_occurred_at, event_id)
);

SELECT create_hypertable('alert_occurrences', by_range('alert_occurred_at', INTERVAL '7 days'));

-- Cursor order of GET /alerts/:id/occurrences (newest first).
CREATE INDEX alert_occurrences_cursor_idx
  ON alert_occurrences (alert_id, alert_occurred_at, occurred_at DESC, event_id DESC);

-- The same retention as alerts.
SELECT add_retention_policy('alert_occurrences', INTERVAL '730 days');

-- 3. Read marks (GET /alerts/unread-count, POST /alerts/read).
--
-- Per user and active organization (NULL: none): open alerts whose latest
-- occurrence is not after read_up_to count as read.
CREATE TABLE alert_read_marks (
  user_id    uuid NOT NULL,
  org_id     uuid,
  read_up_to timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_read_marks_key UNIQUE NULLS NOT DISTINCT (user_id, org_id)
);

-- 4. Signing keys of webhook channels.
--
-- Every webhook channel of a rule (rule + target URL) has its own HMAC secret,
-- shown once when the channel is created or its secret rotated, and its key id
-- is sent as X-AIS-ITS-Key-Id. Channels created before 0.2.0 have no key and
-- keep the deployment secret (WEBHOOK_SIGNING_SECRET) until their secret is
-- rotated. The secret is needed in clear to sign; the API never returns it
-- again and logs never contain it.
CREATE TABLE webhook_keys (
  id         uuid PRIMARY KEY,
  rule_id    uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  target     text NOT NULL,
  secret     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_keys_rule_target_key UNIQUE (rule_id, target)
);
