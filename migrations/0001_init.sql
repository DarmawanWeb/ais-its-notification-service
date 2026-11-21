-- 0001_init — initial schema of ais-its-notification-service (docs/PLATFORM_SPEC.md §6, §13.9).
--
-- Runs inside schema "notify" (search_path=notify,public) as the role
-- notify_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add 0002_<change>.sql instead.

COMMENT ON SCHEMA notify IS 'notification service — owned by notify_svc';

-- Projection of the FLEET stream (consumer notification-fleet): mmsi → owner
-- organization, used for alert tenancy (spec §8.5), rule matching and the
-- org rooms of the realtime gateway.
CREATE TABLE vessels (
  vessel_id    uuid PRIMARY KEY,
  mmsi         integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  org_id       uuid,
  name         text NOT NULL,
  -- updatedAt of the snapshot: older snapshots never overwrite newer ones.
  updated_at   timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vessels_mmsi_key UNIQUE (mmsi)
);

CREATE INDEX vessels_org_idx ON vessels (org_id);

-- Alert inbox (consumer notification-alerts). id = alert id = envelope id of
-- the first occurrence; later occurrences with the same dedup_key merge into
-- the unresolved alert (occurrences, last_occurred_at, severity escalation).
CREATE TABLE alerts (
  id               uuid NOT NULL,
  occurred_at      timestamptz NOT NULL,
  type             text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*$'),
  domain           text NOT NULL CHECK (domain IN ('safety', 'surveillance')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  mmsi             integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  related_mmsi     integer CHECK (related_mmsi BETWEEN 100000000 AND 999999999),
  -- Owner of the vessel when the alert was stored or last merged (nullable:
  -- not every vessel is registered in fleet). Visibility (spec §8.5) is
  -- evaluated against the current projection, see AlertsRepository.
  org_id           uuid,
  title            text NOT NULL,
  message          text NOT NULL,
  lat              double precision CHECK (lat BETWEEN -90 AND 90),
  lon              double precision CHECK (lon BETWEEN -180 AND 180),
  zone_id          uuid,
  method_id        text NOT NULL,
  dedup_key        text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}',
  -- SERVICE_NAME of the producer (envelope source).
  source           text NOT NULL,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  resolved_by      uuid,
  resolved_at      timestamptz,
  occurrences      integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  last_occurred_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  CHECK (last_occurred_at >= occurred_at),
  CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);

SELECT create_hypertable('alerts', by_range('occurred_at', INTERVAL '7 days'));

-- The unresolved alert of a dedup key (merge lookup).
CREATE INDEX alerts_unresolved_dedup_idx ON alerts (dedup_key) WHERE status <> 'resolved';
-- Cursor order of GET /alerts (newest first, id breaks ties).
CREATE INDEX alerts_cursor_idx ON alerts (occurred_at DESC, id DESC);
CREATE INDEX alerts_mmsi_idx ON alerts (mmsi, occurred_at DESC);
CREATE INDEX alerts_related_mmsi_idx ON alerts (related_mmsi, occurred_at DESC)
  WHERE related_mmsi IS NOT NULL;
CREATE INDEX alerts_status_idx ON alerts (status, occurred_at DESC);

ALTER TABLE alerts SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'occurred_at DESC, id'
);
-- Older alerts are history: compressed after 90 days (the ALERTS max age),
-- dropped after two years.
SELECT add_compression_policy('alerts', INTERVAL '90 days');
SELECT add_retention_policy('alerts', INTERVAL '730 days');

-- Alert rules of an organization (tenant-private, spec §8.5). Empty arrays
-- match everything; scope 'all' (rules of authority / super_admin
-- principals) matches vessels of every organization.
CREATE TABLE alert_rules (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  created_by    uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  scope         text NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'all')),
  types         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(types) <= 32),
  domains       text[] NOT NULL DEFAULT '{}'
                  CHECK (domains <@ ARRAY['safety', 'surveillance']::text[]),
  min_severity  text NOT NULL DEFAULT 'info'
                  CHECK (min_severity IN ('info', 'warning', 'critical')),
  mmsi          integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(mmsi) <= 500),
  zone_ids      uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(zone_ids) <= 100),
  -- [{ "type": "email" | "telegram" | "webhook", "target": "…" }]
  channels      jsonb NOT NULL
                  CHECK (jsonb_typeof(channels) = 'array'
                         AND jsonb_array_length(channels) BETWEEN 1 AND 10),
  -- Language of the notification texts.
  locale        text NOT NULL DEFAULT 'id' CHECK (locale IN ('id', 'en')),
  quiet_minutes integer NOT NULL DEFAULT 0 CHECK (quiet_minutes BETWEEN 0 AND 10080),
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alert_rules_org_idx ON alert_rules (org_id, created_at);
CREATE INDEX alert_rules_enabled_scope_idx ON alert_rules (scope, org_id) WHERE enabled;

-- One notification of an alert through one channel of one rule, retried with
-- exponential backoff (pending → sending → sent | failed; e-mails are handed
-- to the NOTIFY stream: sending → queued → sent | failed).
CREATE TABLE deliveries (
  id              uuid PRIMARY KEY,
  alert_id        uuid NOT NULL,
  rule_id         uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email', 'telegram', 'webhook')),
  target          text NOT NULL,
  -- Severity of the alert when the delivery was planned (quiet period).
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'queued', 'sent', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error           text,
  -- What is sent: the alert as pushed to clients, the rule and vessel names.
  payload         jsonb NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX deliveries_rule_alert_idx ON deliveries (rule_id, alert_id, created_at DESC);
CREATE INDEX deliveries_alert_idx ON deliveries (alert_id);
CREATE INDEX deliveries_cursor_idx ON deliveries (created_at DESC, id DESC);

-- Transactional e-mails (consumer notification-email): one row per
-- notify.email.requested.v1 envelope; bodies are never stored (reset links).
CREATE TABLE email_log (
  id          uuid PRIMARY KEY,
  to_address  text NOT NULL,
  template    text NOT NULL
                CHECK (template IN ('password_reset', 'account_invite', 'alert', 'test')),
  locale      text NOT NULL CHECK (locale IN ('id', 'en')),
  subject     text,
  -- SERVICE_NAME of the requester (envelope source).
  source      text NOT NULL,
  -- Set for alert e-mails of a delivery.
  delivery_id uuid,
  status      text NOT NULL CHECK (status IN ('retrying', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error       text,
  message_id  text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_log_created_idx ON email_log (created_at);

-- Envelope ids handled by the durable consumers (withIdempotency, spec §7.1).
CREATE TABLE IF NOT EXISTS "processed_events" (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX IF NOT EXISTS "processed_events_processed_at_idx" ON "processed_events" (processed_at);
