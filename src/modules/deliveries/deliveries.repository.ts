import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

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
  | {
      readonly status: 'pending';
      readonly error: string;
      readonly nextAttemptAt: Date;
    };

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
      .where(
        and(
          eq(deliveries.alertId, alertId),
          inArray(deliveries.ruleId, [...ruleIds]),
        ),
      )
      .orderBy(deliveries.ruleId, desc(deliveries.createdAt));
    return new Map(
      rows.map((row) => [row.ruleId, { at: row.at, severity: row.severity }]),
    );
  }

  async insertMany(
    executor: Executor,
    rows: readonly NewDelivery[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await executor.insert(deliveries).values(rows.map((row) => ({ ...row })));
  }

  /**
   * Claims due deliveries: `pending` ones whose time has come and `sending`
   * ones whose lease expired (an instance crashed mid-attempt). Each claimed
   * delivery counts one more attempt and is leased to the caller. The rows
   * are locked with `FOR UPDATE SKIP LOCKED`, so concurrent instances never
   * claim the same delivery.
   */
  async claimDue(limit: number, leaseMs: number): Promise<Delivery[]> {
    const due = this.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        or(
          and(
            eq(deliveries.status, 'pending'),
            lte(deliveries.nextAttemptAt, sql`now()`),
          ),
          and(
            eq(deliveries.status, 'sending'),
            lt(deliveries.leaseUntil, sql`now()`),
          ),
        ),
      )
      .orderBy(deliveries.nextAttemptAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    return this.db
      .update(deliveries)
      .set({
        status: 'sending',
        attempts: sql`${deliveries.attempts} + 1`,
        leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        lastAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(inArray(deliveries.id, due))
      .returning();
  }

  /** Stores the result of a claimed attempt (only while the claim is ours). */
  async report(
    id: string,
    attempts: number,
    result: AttemptResult,
  ): Promise<void> {
    await this.db
      .update(deliveries)
      .set({
        status: result.status,
        leaseUntil: null,
        updatedAt: sql`now()`,
        ...(result.status === 'sent'
          ? { sentAt: sql`now()`, error: null }
          : {}),
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
  async completeQueued(
    id: string,
    outcome: { sent: true } | { sent: false; error: string },
  ): Promise<void> {
    await this.db
      .update(deliveries)
      .set(
        outcome.sent
          ? {
              status: 'sent',
              sentAt: sql`now()`,
              error: null,
              updatedAt: sql`now()`,
            }
          : { status: 'failed', error: outcome.error, updatedAt: sql`now()` },
      )
      .where(
        and(
          eq(deliveries.id, id),
          inArray(deliveries.status, ['queued', 'sending', 'pending']),
        ),
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
          tenancy.kind === 'all'
            ? undefined
            : eq(alertRules.orgId, tenancy.orgId),
          filter.ruleId === undefined
            ? undefined
            : eq(deliveries.ruleId, filter.ruleId),
          filter.alertId === undefined
            ? undefined
            : eq(deliveries.alertId, filter.alertId),
          filter.status === undefined
            ? undefined
            : eq(deliveries.status, filter.status),
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
      .where(
        and(
          inArray(deliveries.status, ['sent', 'failed']),
          lt(deliveries.updatedAt, before),
        ),
      )
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
