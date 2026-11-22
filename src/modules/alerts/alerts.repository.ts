import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  KNOWN_ALERT_TYPES,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
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

const { alerts, openAlerts, vessels } = schema;

/** A new inbox alert (the database fills the timestamps). */
export type NewInboxAlert = Omit<InboxAlert, 'createdAt' | 'updatedAt'>;

/** Drizzle database of the service, or of one transaction. */
export type Executor = Database<typeof schema>;

/**
 * Drizzle access to the `alerts` hypertable. Reads take an {@link AlertScope}
 * so tenancy (spec §8.5) is part of every query; writes of the consumer run
 * in its transaction (`executor`).
 */
@Injectable()
export class AlertsRepository {
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
