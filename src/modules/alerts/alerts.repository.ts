import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  KNOWN_ALERT_TYPES,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb, rowDate } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type {
  AlertLifecycle,
  MergeableAlert,
} from '../../domain/alert-inbox.js';
import type {
  AlertCursor,
  AlertFilter,
  AlertScope,
  AlertSummary,
  InboxAlert,
} from './alert.js';

const { alertOccurrences, alertReadMarks, alerts, openAlerts, vessels } =
  schema;

/** A new inbox alert (the database fills the timestamps). */
export type NewInboxAlert = Omit<InboxAlert, 'createdAt' | 'updatedAt'>;

/** Drizzle database of the service, or of one transaction. */
export type Executor = Database<typeof schema>;

/** A stored occurrence of an inbox alert (`alert_occurrences` row). */
export type AlertOccurrenceRow = typeof alertOccurrences.$inferSelect;

/** A new occurrence row (the database fills `received_at`). */
export type NewAlertOccurrence = Omit<AlertOccurrenceRow, 'receivedAt'>;

/** Position of an occurrence in the history order (cursor). */
export interface OccurrenceCursor {
  readonly occurredAt: string;
  readonly eventId: string;
}

/** Bucket of `GET /alerts/stats/series` (PostgreSQL `date_trunc` field). */
export type SeriesBucketField = 'hour' | 'day';

/** Dimension of `GET /alerts/stats/series`. */
export type SeriesGroupBy = 'severity' | 'type' | 'domain';

/** One bucket and key of a series (`key` `null`: an empty bucket). */
export interface SeriesCountRow {
  readonly bucketFrom: Date;
  readonly bucketTo: Date;
  readonly key: string | null;
  readonly count: number;
}

/** What a detector resolution stores with the alert. */
export interface ResolutionDetails {
  readonly reason: string | null;
  readonly eventId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Drizzle access to the `alerts` hypertable. Reads take an {@link AlertScope}
 * so tenancy (spec §8.5) is part of every query; writes of the consumer run
 * in its transaction (`executor`).
 */
@Injectable()
export class AlertsRepository {
  /** `pg_timezone_names` by lower-case name, loaded once. */
  private timeZones: Promise<ReadonlyMap<string, string>> | undefined;

  constructor(@InjectDb() private readonly db: Executor) {}

  /**
   * The unresolved alert of a dedup key, found through `open_alerts` and read
   * by primary key and mmsi (its compression segment) without a row lock:
   * TimescaleDB cannot lock tuples of compressed chunks, and the consumer's
   * advisory lock already serializes the occurrences of a key. An entry whose
   * alert is gone (dropped by the retention policy) or resolved is removed,
   * so the next occurrence starts a new alert.
   */
  async findUnresolved(
    executor: Executor,
    dedupKey: string,
  ): Promise<InboxAlert | undefined> {
    const [entry] = await executor
      .select()
      .from(openAlerts)
      .where(eq(openAlerts.dedupKey, dedupKey))
      .limit(1);
    if (entry === undefined) return undefined;
    const [row] = await executor
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.id, entry.alertId),
          eq(alerts.occurredAt, entry.occurredAt),
          eq(alerts.mmsi, entry.mmsi),
        ),
      )
      .limit(1);
    if (row !== undefined && row.status !== 'resolved') return row;
    await executor
      .delete(openAlerts)
      .where(
        and(
          eq(openAlerts.dedupKey, dedupKey),
          eq(openAlerts.alertId, entry.alertId),
        ),
      );
    return undefined;
  }

  /**
   * Inserts a new (open) alert and its `open_alerts` entry.
   *
   * @returns `undefined` when an alert with its id and time exists already
   */
  async insert(
    executor: Executor,
    alert: NewInboxAlert,
  ): Promise<InboxAlert | undefined> {
    const [row] = await executor
      .insert(alerts)
      .values({ ...alert })
      .onConflictDoNothing()
      .returning();
    if (row === undefined) return undefined;
    await executor.insert(openAlerts).values({
      dedupKey: row.dedupKey,
      alertId: row.id,
      occurredAt: row.occurredAt,
      mmsi: row.mmsi,
    });
    return row;
  }

  /**
   * Writes a merged occurrence into the stored alert if its status is still
   * the one the merge read (a concurrent acknowledge or resolve wins; merges
   * of one key are serialized by the consumer's advisory lock, so the status
   * is a complete concurrency token).
   *
   * @returns the updated alert, or `undefined` when its status changed meanwhile
   */
  async updateMerged(
    executor: Executor,
    stored: Pick<InboxAlert, 'id' | 'occurredAt' | 'mmsi' | 'status'>,
    merged: MergeableAlert,
    orgId: string | null,
  ): Promise<InboxAlert | undefined> {
    const [row] = await executor
      .update(alerts)
      .set({
        severity: merged.severity,
        status: merged.status,
        occurrences: merged.occurrences,
        lastOccurredAt: merged.lastOccurredAt,
        title: merged.title,
        message: merged.message,
        lat: merged.lat,
        lon: merged.lon,
        relatedMmsi: merged.relatedMmsi,
        zoneId: merged.zoneId,
        methodId: merged.methodId,
        data: { ...merged.data },
        acknowledgedBy: merged.acknowledgedBy,
        acknowledgedAt: merged.acknowledgedAt,
        ...(orgId === null ? {} : { orgId }),
        updatedAt: sql`now()`,
      })
      .where(and(identifies(stored), eq(alerts.status, stored.status)))
      .returning();
    return row;
  }

  /**
   * Records an occurrence in the alert's history (idempotent: an occurrence
   * stored before is left as it is).
   */
  async insertOccurrence(
    executor: Executor,
    occurrence: NewAlertOccurrence,
  ): Promise<void> {
    await executor
      .insert(alertOccurrences)
      .values({ ...occurrence, data: { ...occurrence.data } })
      .onConflictDoNothing();
  }

  /**
   * Whether the consumer has stored the raise with envelope id `eventId`:
   * the first raise of `unresolved`, an id recorded in `processed_events`
   * (kept `IDEMPOTENCY_RETENTION_DAYS`) or an occurrence in the history of
   * `unresolved` (which outlives pruned ids). Run it under the dedup key's
   * advisory lock: an ingest of the key holding it has not committed, so it
   * does not count yet.
   */
  async raiseStored(
    executor: Executor,
    consumer: string,
    eventId: string,
    unresolved: Pick<InboxAlert, 'id' | 'occurredAt'> | undefined,
  ): Promise<boolean> {
    if (unresolved?.id === eventId) return true;
    const inHistory =
      unresolved === undefined
        ? sql`false`
        : sql`EXISTS (
            SELECT 1 FROM ${alertOccurrences}
            WHERE ${alertOccurrences.alertId} = ${unresolved.id}
              AND ${alertOccurrences.alertOccurredAt} = ${unresolved.occurredAt}
              AND ${alertOccurrences.eventId} = ${eventId})`;
    const { rows } = await executor.execute<{ stored: boolean }>(sql`
      SELECT EXISTS (
               SELECT 1 FROM processed_events
               WHERE consumer = ${consumer} AND event_id = ${eventId})
             OR ${inHistory} AS stored`);
    return rows[0]?.stored === true;
  }

  /**
   * Resolves an alert for a detector (`alert.resolved.v1`) if its status is
   * still the one that was read (a concurrent acknowledge or resolve over
   * REST wins; occurrences of the key are serialized by the consumer's
   * advisory lock) and removes its `open_alerts` entry, in the consumer's
   * transaction.
   *
   * @returns the resolved alert, or `undefined` when its status changed meanwhile
   */
  async resolveForDetector(
    executor: Executor,
    stored: Pick<InboxAlert, 'id' | 'occurredAt' | 'mmsi' | 'status'>,
    lifecycle: AlertLifecycle,
    resolution: ResolutionDetails,
  ): Promise<InboxAlert | undefined> {
    const [row] = await executor
      .update(alerts)
      .set({
        status: lifecycle.status,
        acknowledgedBy: lifecycle.acknowledgedBy,
        acknowledgedAt: lifecycle.acknowledgedAt,
        resolvedBy: lifecycle.resolvedBy,
        resolvedAt: lifecycle.resolvedAt,
        resolutionReason: resolution.reason,
        resolutionEventId: resolution.eventId,
        resolutionData: { ...resolution.data },
        updatedAt: sql`now()`,
      })
      .where(and(identifies(stored), eq(alerts.status, stored.status)))
      .returning();
    if (row === undefined) return undefined;
    await executor
      .delete(openAlerts)
      .where(
        and(
          eq(openAlerts.dedupKey, row.dedupKey),
          eq(openAlerts.alertId, row.id),
        ),
      );
    return row;
  }

  /** An alert visible in `scope`. */
  async findById(
    id: string,
    scope: AlertScope,
  ): Promise<InboxAlert | undefined> {
    const [row] = await this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, id), this.scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** The history of an alert, newest occurrence first, `limit` rows after the cursor. */
  async listOccurrences(
    alert: Pick<InboxAlert, 'id' | 'occurredAt'>,
    after: OccurrenceCursor | undefined,
    limit: number,
  ): Promise<AlertOccurrenceRow[]> {
    return this.db
      .select()
      .from(alertOccurrences)
      .where(
        and(
          eq(alertOccurrences.alertId, alert.id),
          eq(alertOccurrences.alertOccurredAt, alert.occurredAt),
          after === undefined
            ? undefined
            : sql`(${alertOccurrences.occurredAt}, ${alertOccurrences.eventId}) < (${new Date(after.occurredAt)}, ${after.eventId})`,
        ),
      )
      .orderBy(
        desc(alertOccurrences.occurredAt),
        desc(alertOccurrences.eventId),
      )
      .limit(limit);
  }

  /** The read mark of a user in an organization (`null`: none). */
  async findReadMark(
    userId: string,
    orgId: string | null,
  ): Promise<Date | undefined> {
    const [row] = await this.db
      .select({ readUpTo: alertReadMarks.readUpTo })
      .from(alertReadMarks)
      .where(
        and(
          eq(alertReadMarks.userId, userId),
          orgId === null
            ? isNull(alertReadMarks.orgId)
            : eq(alertReadMarks.orgId, orgId),
        ),
      )
      .limit(1);
    return row?.readUpTo;
  }

  /**
   * Moves the read mark of a user in an organization forward to `upTo`
   * (never backwards).
   *
   * @returns the stored mark
   */
  async advanceReadMark(
    userId: string,
    orgId: string | null,
    upTo: Date,
  ): Promise<Date> {
    const [row] = await this.db
      .insert(alertReadMarks)
      .values({ userId, orgId, readUpTo: upTo })
      .onConflictDoUpdate({
        target: [alertReadMarks.userId, alertReadMarks.orgId],
        set: {
          readUpTo: sql`GREATEST(${alertReadMarks.readUpTo}, excluded.read_up_to)`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ readUpTo: alertReadMarks.readUpTo });
    if (row === undefined) throw new Error('Read mark upsert returned no row');
    return row.readUpTo;
  }

  /**
   * Open alerts visible in `scope` stored or changed after `readUpTo`
   * (`updated_at`; every open alert without a mark).
   */
  async countUnread(
    scope: AlertScope,
    readUpTo: Date | undefined,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(alerts)
      .where(
        and(
          eq(alerts.status, 'open'),
          this.scopeCondition(scope),
          readUpTo === undefined
            ? undefined
            : sql`${alerts.updatedAt} > ${readUpTo}`,
        ),
      );
    return row?.count ?? 0;
  }

  /** Alerts matching the filter, counted up to `max` (a capped count for exports). */
  async countUpTo(
    filter: AlertFilter,
    scope: AlertScope,
    max: number,
  ): Promise<number> {
    const capped = this.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(this.scopeCondition(scope), ...filterConditions(filter)))
      .limit(max)
      .as('capped');
    const [row] = await this.db.select({ count: count() }).from(capped);
    return row?.count ?? 0;
  }

  /**
   * The database's spelling of a time zone name (`pg_timezone_names`,
   * case-insensitive like PostgreSQL), `undefined` for a name it does not
   * know (ICU knows aliases the database's tzdata may lack). Read once; a
   * failed read is retried.
   */
  async timeZoneName(name: string): Promise<string | undefined> {
    this.timeZones ??= this.db
      .execute<{ name: string }>(sql`SELECT name FROM pg_timezone_names`)
      .then(
        ({ rows }) =>
          new Map(rows.map((row) => [row.name.toLowerCase(), row.name])),
        (error: unknown) => {
          this.timeZones = undefined;
          throw error;
        },
      );
    return (await this.timeZones).get(name.toLowerCase());
  }

  /**
   * Alerts visible in `scope` per bucket of their first occurrence
   * (`occurred_at`) and `groupBy` value: every local hour or day of
   * `timeZone` from the bucket containing `filter.from` to the one
   * containing `filter.to`, in order, empty ones included (`key` `null`).
   * The counts hold the filter's range only, so the first and last bucket
   * count just their part of `[filter.from, filter.to]` (the service clips
   * their bounds to match, `assembleSeries`). Bucket starts are the distinct local truncations
   * (`date_trunc(bucket, t, timeZone)`, as the counts use) of an
   * absolute-time grid finer than any local hour or day (zone offsets are
   * multiples of 15 minutes), so a repeated hour at the end of daylight
   * saving time is two buckets, a skipped one none, and a day is 23 to 25
   * hours where the zone shifts its clock.
   */
  async series(
    filter: AlertFilter & { readonly from: Date },
    scope: AlertScope,
    bucket: SeriesBucketField,
    timeZone: string,
    groupBy: SeriesGroupBy,
  ): Promise<SeriesCountRow[]> {
    const step = bucket === 'hour' ? '15 minutes' : '1 hour';
    // Past `to`, so that the bucket containing it has a successor.
    const pad = bucket === 'hour' ? '2 hours' : '2 days';
    const key =
      groupBy === 'severity'
        ? alerts.severity
        : groupBy === 'type'
          ? alerts.type
          : alerts.domain;
    const conditions = and(
      this.scopeCondition(scope),
      ...filterConditions(filter),
    );
    const { rows } = await this.db.execute<{
      bucket_from: Date | string;
      bucket_to: Date | string;
      key: string | null;
      count: number | null;
    }>(sql`
      WITH starts AS (
        SELECT DISTINCT date_trunc(${bucket}, grid, ${timeZone}) AS bucket_from
        FROM generate_series(
          ${filter.from}::timestamptz,
          ${filter.to}::timestamptz + ${pad}::interval,
          ${step}::interval
        ) AS grid
      ),
      series AS (
        SELECT bucket_from, lead(bucket_from) OVER (ORDER BY bucket_from) AS bucket_to
        FROM starts
      ),
      counts AS (
        SELECT date_trunc(${bucket}, ${alerts.occurredAt}, ${timeZone}) AS bucket_from,
               ${key} AS key, count(*)::integer AS count
        FROM ${alerts}
        WHERE ${conditions ?? sql`true`}
        GROUP BY 1, 2
      )
      SELECT s.bucket_from, s.bucket_to, c.key, c.count
      FROM series s
      LEFT JOIN counts c ON c.bucket_from = s.bucket_from
      WHERE s.bucket_to IS NOT NULL AND s.bucket_from <= ${filter.to}::timestamptz
      ORDER BY s.bucket_from, c.key`);
    return rows.map((row) => ({
      bucketFrom: rowDate(row.bucket_from),
      bucketTo: rowDate(row.bucket_to),
      key: row.key,
      count: row.count ?? 0,
    }));
  }

  /** Newest first (`occurred_at DESC, id DESC`), `limit` rows after the cursor. */
  async list(
    filter: AlertFilter,
    scope: AlertScope,
    after: AlertCursor | undefined,
    limit: number,
  ): Promise<InboxAlert[]> {
    return this.db
      .select()
      .from(alerts)
      .where(
        and(
          this.scopeCondition(scope),
          ...filterConditions(filter),
          after === undefined
            ? undefined
            : sql`(${alerts.occurredAt}, ${alerts.id}) < (${new Date(after.occurredAt)}, ${after.id})`,
        ),
      )
      .orderBy(desc(alerts.occurredAt), desc(alerts.id))
      .limit(limit);
  }

  /** Counts of open alerts by severity, domain and type. */
  async summary(scope: AlertScope): Promise<AlertSummary> {
    const rows = await this.db
      .select({
        severity: alerts.severity,
        domain: alerts.domain,
        type: alerts.type,
        count: count(),
      })
      .from(alerts)
      .where(and(eq(alerts.status, 'open'), this.scopeCondition(scope)))
      .groupBy(alerts.severity, alerts.domain, alerts.type);
    const bySeverity = Object.fromEntries(
      ALERT_SEVERITIES.map((s) => [s, 0]),
    ) as Record<(typeof ALERT_SEVERITIES)[number], number>;
    const byDomain = Object.fromEntries(
      ALERT_DOMAINS.map((d) => [d, 0]),
    ) as Record<(typeof ALERT_DOMAINS)[number], number>;
    const byType: Record<string, number> = Object.fromEntries(
      KNOWN_ALERT_TYPES.map((type) => [type, 0]),
    );
    let total = 0;
    for (const row of rows) {
      total += row.count;
      bySeverity[row.severity] += row.count;
      byDomain[row.domain] += row.count;
      byType[row.type] = (byType[row.type] ?? 0) + row.count;
    }
    return { total, bySeverity, byDomain, byType };
  }

  /**
   * Applies a lifecycle change if the alert is still in the status that was
   * read (optimistic concurrency with merges and other actions); resolving
   * removes the `open_alerts` entry in the same transaction, so the next
   * occurrence of the dedup key starts a new alert.
   *
   * @returns the updated alert, or `undefined` when its status changed meanwhile
   */
  async updateLifecycle(
    alert: Pick<InboxAlert, 'id' | 'occurredAt' | 'mmsi' | 'status'>,
    lifecycle: AlertLifecycle,
  ): Promise<InboxAlert | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(alerts)
        .set({
          status: lifecycle.status,
          acknowledgedBy: lifecycle.acknowledgedBy,
          acknowledgedAt: lifecycle.acknowledgedAt,
          resolvedBy: lifecycle.resolvedBy,
          resolvedAt: lifecycle.resolvedAt,
          updatedAt: sql`now()`,
        })
        .where(and(identifies(alert), eq(alerts.status, alert.status)))
        .returning();
      if (row?.status === 'resolved') {
        await tx
          .delete(openAlerts)
          .where(
            and(
              eq(openAlerts.dedupKey, row.dedupKey),
              eq(openAlerts.alertId, row.id),
            ),
          );
      }
      return row;
    });
  }

  /**
   * Removes `open_alerts` entries older than `before` whose alert row no
   * longer exists (its chunk was dropped by the retention policy while the
   * alert was unresolved).
   *
   * @returns the number of entries removed
   */
  async pruneOrphanedOpenAlerts(before: Date): Promise<number> {
    const rows = await this.db
      .delete(openAlerts)
      .where(
        and(
          lt(openAlerts.occurredAt, before),
          notExists(
            this.db
              .select({ id: alerts.id })
              .from(alerts)
              .where(
                and(
                  eq(alerts.id, openAlerts.alertId),
                  eq(alerts.occurredAt, openAlerts.occurredAt),
                ),
              ),
          ),
        ),
      )
      .returning({ dedupKey: openAlerts.dedupKey });
    return rows.length;
  }

  /** Tenancy of spec §8.5 as a SQL condition. */
  private scopeCondition(scope: AlertScope): SQL | undefined {
    switch (scope.kind) {
      case 'all':
        return undefined;
      case 'none':
        return sql`false`;
      case 'org': {
        const owned = this.db
          .select({ mmsi: vessels.mmsi })
          .from(vessels)
          .where(
            and(eq(vessels.orgId, scope.orgId), isNull(vessels.deletedAt)),
          );
        return or(
          inArray(alerts.mmsi, owned),
          inArray(alerts.relatedMmsi, owned),
        );
      }
    }
  }
}

/**
 * The row of an alert: primary key plus mmsi, the compression segment, so a
 * write to an old alert only decompresses its own segment.
 */
function identifies(
  alert: Pick<InboxAlert, 'id' | 'occurredAt' | 'mmsi'>,
): SQL | undefined {
  return and(
    eq(alerts.id, alert.id),
    eq(alerts.occurredAt, alert.occurredAt),
    eq(alerts.mmsi, alert.mmsi),
  );
}

function filterConditions(filter: AlertFilter): (SQL | undefined)[] {
  return [
    filter.status === undefined ? undefined : eq(alerts.status, filter.status),
    filter.type === undefined ? undefined : eq(alerts.type, filter.type),
    filter.domain === undefined ? undefined : eq(alerts.domain, filter.domain),
    filter.severity === undefined
      ? undefined
      : eq(alerts.severity, filter.severity),
    filter.mmsi === undefined
      ? undefined
      : or(eq(alerts.mmsi, filter.mmsi), eq(alerts.relatedMmsi, filter.mmsi)),
    filter.from === undefined ? undefined : gte(alerts.occurredAt, filter.from),
    lte(alerts.occurredAt, filter.to),
  ];
}
