-- 0002_review_hardening — review hardening of the inbox merge, the FLEET
-- projection and the e-mail consumer (docs/PLATFORM_SPEC.md §6, §7.1, §13.9).
--
-- Runs inside schema "notify" (search_path=notify,public) as notify_svc, in one
-- transaction. Forward-only: never edit once applied, add 0003_<change>.sql.

-- 1. Index of the unresolved inbox alerts, one row per dedup key.
--
-- The merge used to look the unresolved alert up in the `alerts` hypertable
-- with SELECT … FOR UPDATE. TimescaleDB cannot lock tuples of compressed
-- chunks ("locking compressed tuples is not supported"), and chunks are
-- compressed after 90 days while an alert may stay unresolved for months, so
-- every later occurrence of such a key failed and was dead-lettered. A key
-- that had no unresolved alert also had to be searched in every (compressed)
-- chunk. This regular table answers the lookup with a primary-key read; the
-- alert row itself is then read by its primary key and mmsi (the compression
-- segment) without a row lock. Occurrences of a key are serialized by the
-- transaction advisory lock of the consumer, lifecycle changes by conditional
-- updates on `alerts.status` (AlertsRepository).
CREATE TABLE open_alerts (
  dedup_key   text PRIMARY KEY,
  alert_id    uuid NOT NULL,
  -- Primary key and compression segment of the alert row (alerts.occurred_at
  -- and alerts.mmsi never change on a merge).
  occurred_at timestamptz NOT NULL,
  mmsi        integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Housekeeping of entries whose alert was dropped by the retention policy.
CREATE INDEX open_alerts_occurred_idx ON open_alerts (occurred_at);

INSERT INTO open_alerts (dedup_key, alert_id, occurred_at, mmsi)
SELECT DISTINCT ON (dedup_key) dedup_key, id, occurred_at, mmsi
  FROM alerts
 WHERE status <> 'resolved'
 ORDER BY dedup_key, occurred_at DESC;

-- Replaced by open_alerts (it never covered compressed chunks either).
DROP INDEX IF EXISTS alerts_unresolved_dedup_idx;

-- 2. Tombstones in the FLEET projection.
--
-- fleet.vessel.deleted.v1 used to delete the row. An earlier upsert of the
-- same vessel that failed transiently is redelivered after its backoff, after
-- the delete, and re-inserted the deleted vessel for good (FLEET keeps only
-- the delete per subject). Deleted vessels now keep their row with
-- deleted_at set: fleet never reuses a vessel id, so a tombstoned vessel
-- ignores every later snapshot. Tombstones keep their mmsi for reference but
-- take no part in mmsi uniqueness, so a new vessel can take the MMSI over.
ALTER TABLE vessels ADD COLUMN deleted_at timestamptz;

ALTER TABLE vessels DROP CONSTRAINT vessels_mmsi_key;
CREATE UNIQUE INDEX vessels_mmsi_key ON vessels (mmsi) WHERE deleted_at IS NULL;

COMMENT ON COLUMN vessels.deleted_at IS
  'Envelope time of fleet.vessel.deleted.v1; tombstoned rows are not live vessels';

-- 3. A claim before the SMTP exchange (consumer notification-email).
--
-- NOTIFY requests all share one subject, so the consumer no longer orders by
-- subject (one slow SMTP exchange held every e-mail behind it). Two copies of
-- one request (a producer that republished after the 2-minute dedup window,
-- or a lost e-mail queued again by the housekeeping) can then be handled at
-- the same time: the copy that claims the row ('sending', claimed_until)
-- sends, the other one waits for the outcome. An expired claim (a crashed
-- instance) can be taken over.
ALTER TABLE email_log DROP CONSTRAINT email_log_status_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_status_check
  CHECK (status IN ('sending', 'retrying', 'sent', 'failed'));
ALTER TABLE email_log ADD COLUMN claimed_until timestamptz;

-- Alert e-mails still queued (housekeeping: requeue of lost NOTIFY requests).
CREATE INDEX deliveries_queued_idx ON deliveries (updated_at) WHERE status = 'queued';
