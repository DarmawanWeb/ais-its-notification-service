import { type PageQuery, pageOffset } from '@darmawanweb/ais-its-contracts/api';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { RuleScope } from '../../domain/alert-rules.js';
import type {
  AlertRule,
  AlertRuleChanges,
  AlertRuleFilter,
  RuleTenancy,
} from './alert-rule.js';

const { alertRules } = schema;

/** Drizzle database of the service, or of one transaction. */
export type Executor = Database<typeof schema>;

/** A rule to insert (the database fills the timestamps). */
export type NewAlertRule = Omit<AlertRule, 'createdAt' | 'updatedAt'>;

/** Columns a create or update writes (drizzle wants mutable arrays). */
type RuleColumns = Partial<
  Omit<typeof alertRules.$inferInsert, 'id' | 'orgId' | 'createdBy'>
>;

/** The rule fields as column values; absent fields stay absent. */
function toColumns(fields: AlertRuleChanges): RuleColumns {
  const columns: RuleColumns = {};
  if (fields.name !== undefined) columns.name = fields.name;
  if (fields.scope !== undefined) columns.scope = fields.scope;
  if (fields.types !== undefined) columns.types = [...fields.types];
  if (fields.domains !== undefined) columns.domains = [...fields.domains];
  if (fields.minSeverity !== undefined)
    columns.minSeverity = fields.minSeverity;
  if (fields.mmsi !== undefined) columns.mmsi = [...fields.mmsi];
  if (fields.zoneIds !== undefined) columns.zoneIds = [...fields.zoneIds];
  if (fields.channels !== undefined) {
    columns.channels = fields.channels.map((channel) => ({
      type: channel.type,
      target: channel.target,
    }));
  }
  if (fields.locale !== undefined) columns.locale = fields.locale;
  if (fields.quietMinutes !== undefined)
    columns.quietMinutes = fields.quietMinutes;
  if (fields.enabled !== undefined) columns.enabled = fields.enabled;
  return columns;
}

/** Drizzle access to `alert_rules`, restricted to a {@link RuleTenancy}. */
@Injectable()
export class AlertRulesRepository {
  constructor(@InjectDb() private readonly db: Executor) {}

  async insert(rule: NewAlertRule): Promise<AlertRule> {
    const [row] = await this.db
      .insert(alertRules)
      .values({
        ...toColumns(rule),
        id: rule.id,
        orgId: rule.orgId,
        createdBy: rule.createdBy,
        name: rule.name,
        channels: rule.channels.map((channel) => ({
          type: channel.type,
          target: channel.target,
        })),
      })
      .returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  async findById(
    id: string,
    tenancy: RuleTenancy,
  ): Promise<AlertRule | undefined> {
    const [row] = await this.db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.id, id), tenancyCondition(tenancy)))
      .limit(1);
    return row;
  }

  /** Newest first. */
  async list(
    filter: AlertRuleFilter,
    tenancy: RuleTenancy,
    page: PageQuery,
  ): Promise<{ rows: AlertRule[]; total: number }> {
    const where = and(
      tenancyCondition(tenancy),
      filter.orgId === undefined
        ? undefined
        : eq(alertRules.orgId, filter.orgId),
      filter.enabled === undefined
        ? undefined
        : eq(alertRules.enabled, filter.enabled),
    );
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(alertRules)
        .where(where)
        .orderBy(desc(alertRules.createdAt), desc(alertRules.id))
        .limit(page.pageSize)
        .offset(pageOffset(page)),
      this.db.select({ total: count() }).from(alertRules).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /**
   * Applies `changes` while the rule still has `expectedScope` (the scope its
   * authorization was checked against).
   *
   * @returns the updated rule, `undefined` when it is gone or its scope changed
   */
  async update(
    id: string,
    tenancy: RuleTenancy,
    expectedScope: RuleScope,
    changes: AlertRuleChanges,
  ): Promise<AlertRule | undefined> {
    const [row] = await this.db
      .update(alertRules)
      .set({ ...toColumns(changes), updatedAt: sql`now()` })
      .where(
        and(
          eq(alertRules.id, id),
          tenancyCondition(tenancy),
          eq(alertRules.scope, expectedScope),
        ),
      )
      .returning();
    return row;
  }

  /** Deletes a rule (its deliveries cascade); `undefined` when none matched. */
  async delete(
    id: string,
    tenancy: RuleTenancy,
  ): Promise<AlertRule | undefined> {
    const [row] = await this.db
      .delete(alertRules)
      .where(and(eq(alertRules.id, id), tenancyCondition(tenancy)))
      .returning();
    return row;
  }

  /**
   * Enabled rules that may match an alert of vessels owned by `orgIds`: rules
   * of scope `all` and the rules of those organizations. The criteria are
   * evaluated by `ruleMatchesAlert`.
   */
  async candidates(
    executor: Executor,
    orgIds: readonly string[],
  ): Promise<AlertRule[]> {
    const unique = [...new Set(orgIds)];
    return executor
      .select()
      .from(alertRules)
      .where(
        and(
          eq(alertRules.enabled, true),
          unique.length === 0
            ? eq(alertRules.scope, 'all')
            : or(
                eq(alertRules.scope, 'all'),
                inArray(alertRules.orgId, unique),
              ),
        ),
      )
      .orderBy(alertRules.createdAt, alertRules.id);
  }
}

function tenancyCondition(tenancy: RuleTenancy): SQL | undefined {
  return tenancy.kind === 'all'
    ? undefined
    : eq(alertRules.orgId, tenancy.orgId);
}
