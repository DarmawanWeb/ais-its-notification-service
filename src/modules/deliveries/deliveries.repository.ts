import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { LastNotification } from '../../domain/alert-rules.js';
import type { RuleTenancy } from '../rules/alert-rule.js';
import type { Delivery, DeliveryCursor, DeliveryFilter } from './delivery.js';

const { alertRules, deliveries } = schema;

/** Drizzle database of the service, or of one transaction. */
export type Executor = Database<typeof schema>;

/** A delivery to plan. */
export type NewDelivery = Pick<
  Delivery,
  'id' | 'alertId' | 'ruleId' | 'channel' | 'target' | 'severity' | 'payload'
>;

/** Result of an attempt, as stored. */
export type AttemptResult =
  | { readonly status: 'sent' | 'queued' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'pending'; readonly error: string; readonly nextAttemptAt: Date };

/**
 * Drizzle access to `deliveries`: planning (in the alert transaction), the
 * worker's claim / report cycle (multi-instance safe with `FOR UPDATE SKIP
 * LOCKED` and leases) and the tenant-scoped listing.
 */
@Injectable()
export class DeliveriesRepository {
  constructor(@InjectDb() private readonly db: Executor) {}

  /** Latest notification of `alertId` per rule (quiet period). */
  async lastNotifications(
    executor: Executor,
    alertId: string,
    ruleIds: readonly string[],
  ): Promise<Map<string, LastNotification>> {
    if (ruleIds.length === 0) return new Map();
    const rows = await executor
      .selectDistinctOn([deliveries.ruleId], {
        ruleId: deliveries.ruleId,
        at: deliveries.createdAt,
        severity: deliveries.severity,
      })
      .from(deliveries)
      .where(and(eq(deliveries.alertId, alertId), inArray(deliveries.ruleId, [...ruleIds])))
      .orderBy(deliveries.ruleId, desc(deliveries.createdAt));
    return new Map(rows.map((row) => [row.ruleId, { at: row.at, severity: row.severity }]));
  }

  async insertMany(executor: Executor, rows: readonly NewDelivery[]): Promise<void> {
    if (rows.length === 0) return;
    await executor.insert(deliveries).values(rows.map((row) => ({ ...row })));
  }

  /**
   * Claims due deliveries: `pending` ones whose time has come and `sending`
   * ones whose lease expired (an instance crashed mid-attempt). Each claimed
   * delivery counts one more attempt and is leased to the caller.
   */
  async claimDue(limit: number, leaseMs: number): Promise<Delivery[]> {
    return this.db.execute<Delivery>(sql`
      UPDATE ${deliveries} AS d
      SET status = 'sending',
          attempts = d.attempts + 1,
          lease_until = now() + ${`${leaseMs} milliseconds`}::interval,
          last_attempt_at = now(),
          updated_at = now()
      WHERE d.id IN (
        SELECT id FROM ${deliveries}
        WHERE (status = 'pending' AND next_attempt_at <= now())
           OR (status = 'sending' AND lease_until < now())
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d.id AS "id", d.alert_id AS "alertId", d.rule_id AS "ruleId",
        d.channel AS "channel", d.target AS "target", d.severity AS "severity",
        d.status AS "status", d.attempts AS "attempts", d.error AS "error",
        d.payload AS "payload", d.next_attempt_at AS "nextAttemptAt",
        d.lease_until AS "leaseUntil", d.last_attempt_at AS "lastAttemptAt",
        d.sent_at AS "sentAt", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
    `).then((result) => result.rows.map(reviveDates));
  }

  /** Stores the result of a claimed attempt (only while the claim is ours). */
  async report(id: string, attempts: number, result: AttemptResult): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: result.status,
        leaseUntil: null,
        updatedAt: sql`now()`,
        ...(result.status === 'sent' ? { sentAt: sql`now()`, error: null } : {}),
        ...(result.status === 'queued' ? { error: null } : {}),
        ...(result.status === 'failed' ? { error: result.error } : {}),
        ...(result.status === 'pending'
          ? { error: result.error, nextAttemptAt: result.nextAttemptAt }
          : {}),
      })
      .where(
        and(
          eq(deliveries.id, id),
          eq(deliveries.status, 'sending'),
          eq(deliveries.attempts, attempts),
        ),
      );
  }

  /** The e-mail pipeline delivered (or gave up on) a queued alert e-mail. */
  async completeQueued(id: string, outcome: { sent: true } | { sent: false; error: string }): Promise<void> {
    await this.db
      .update(deliveries)
      .set(
        outcome.sent
          ? { status: 'sent', sentAt: sql`now()`, error: null, updatedAt: sql`now()` }
          : { status: 'failed', error: outcome.error, updatedAt: sql`now()` },
      )
      .where(
        and(eq(deliveries.id, id), inArray(deliveries.status, ['queued', 'sending', 'pending'])),
      );
  }

  /** Deliveries of rules in `tenancy`, newest first. */
  async list(
    filter: DeliveryFilter,
    tenancy: RuleTenancy,
    after: DeliveryCursor | undefined,
    limit: number,
  ): Promise<Delivery[]> {
    const rows = await this.db
      .select({ delivery: deliveries })
      .from(deliveries)
      .innerJoin(alertRules, eq(alertRules.id, deliveries.ruleId))
      .where(
        and(
          tenancy.kind === 'all' ? undefined : eq(alertRules.orgId, tenancy.orgId),
          filter.ruleId === undefined ? undefined : eq(deliveries.ruleId, filter.ruleId),
          filter.alertId === undefined ? undefined : eq(deliveries.alertId, filter.alertId),
          filter.status === undefined ? undefined : eq(deliveries.status, filter.status),
          after === undefined ? undefined : cursorCondition(after),
        ),
      )
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(limit);
    return rows.map((row) => row.delivery);
  }

  /** Deletes finished deliveries older than `before`. */
  async pruneFinished(before: Date): Promise<number> {
    const rows = await this.db
      .delete(deliveries)
      .where(and(inArray(deliveries.status, ['sent', 'failed']), lt(deliveries.updatedAt, before)))
      .returning({ id: deliveries.id });
    return rows.length;
  }
}

function cursorCondition(after: DeliveryCursor): SQL | undefined {
  const createdAt = new Date(after.createdAt);
  return or(
    lt(deliveries.createdAt, createdAt),
    and(eq(deliveries.createdAt, createdAt), lt(deliveries.id, after.id)),
  );
}

/** Raw `execute()` rows carry timestamps as strings (no column mapping). */
function reviveDates(row: Delivery): Delivery {
  const date = (value: unknown): Date | null =>
    value === null || value === undefined ? null : new Date(value as string | Date);
  return {
    ...row,
    nextAttemptAt: date(row.nextAttemptAt) ?? new Date(),
    leaseUntil: date(row.leaseUntil),
    lastAttemptAt: date(row.lastAttemptAt),
    sentAt: date(row.sentAt),
    createdAt: date(row.createdAt) ?? new Date(),
    updatedAt: date(row.updatedAt) ?? new Date(),
  };
}
