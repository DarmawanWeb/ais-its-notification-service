import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import * as schema from '../../../db/schema.js';
import {
  newWebhookSecret,
  type WebhookSigningKey,
} from '../../../domain/webhook-signature.js';

const { alertRules, webhookKeys } = schema;

/** Drizzle database of the service, or of one transaction. */
type Executor = Database<typeof schema>;

/**
 * The key of a webhook channel as a rule response shows it: the key id, and
 * the secret only in the response that created it.
 */
export interface ChannelKeyView {
  readonly keyId: string;
  /** Set only when the key was created by this request (shown once). */
  readonly signingSecret: string | null;
}

/** Keys of a rule's webhook channels by target URL. */
export type RuleChannelKeys = ReadonlyMap<string, ChannelKeyView>;

/** The distinct webhook targets of a rule's channels. */
export function webhookTargets(
  channels: readonly { readonly type: string; readonly target: string }[],
): string[] {
  return [
    ...new Set(
      channels
        .filter((channel) => channel.type === 'webhook')
        .map((channel) => channel.target),
    ),
  ];
}

/**
 * Signing keys of webhook channels (`webhook_keys`): one per rule and
 * target URL. Channels created before 0.2.0 have none (the deployment
 * secret signs them) until their secret is rotated.
 */
@Injectable()
export class WebhookKeysRepository {
  constructor(@InjectDb() private readonly db: Executor) {}

  /** Key ids of the webhook channels of rules (no secrets). */
  async keyIdsOf(
    ruleIds: readonly string[],
  ): Promise<Map<string, Map<string, string>>> {
    const byRule = new Map<string, Map<string, string>>();
    if (ruleIds.length === 0) return byRule;
    const rows = await this.db
      .select({
        ruleId: webhookKeys.ruleId,
        target: webhookKeys.target,
        id: webhookKeys.id,
      })
      .from(webhookKeys)
      .where(inArray(webhookKeys.ruleId, [...new Set(ruleIds)]));
    for (const row of rows) {
      const targets = byRule.get(row.ruleId) ?? new Map<string, string>();
      targets.set(row.target, row.id);
      byRule.set(row.ruleId, targets);
    }
    return byRule;
  }

  /**
   * Brings the keys of a rule in line with its channels, in the caller's
   * transaction: targets that became webhook channels get a new key (its
   * secret is returned once), keys of targets that are no channel any more
   * are deleted, and targets that stay keep their key — or, for channels
   * from before 0.2.0, the deployment secret.
   *
   * @param previous - webhook targets before the change (none for a new rule)
   * @param next - webhook targets after the change
   */
  async reconcile(
    executor: Executor,
    ruleId: string,
    previous: readonly string[],
    next: readonly string[],
  ): Promise<RuleChannelKeys> {
    await executor
      .delete(webhookKeys)
      .where(
        next.length === 0
          ? eq(webhookKeys.ruleId, ruleId)
          : and(
              eq(webhookKeys.ruleId, ruleId),
              notInArray(webhookKeys.target, [...next]),
            ),
      );
    const added = next.filter((target) => !previous.includes(target));
    const created = new Map<string, ChannelKeyView>();
    for (const target of added) {
      const key = { id: newId(), secret: newWebhookSecret() };
      const [row] = await executor
        .insert(webhookKeys)
        .values({ id: key.id, ruleId, target, secret: key.secret })
        .onConflictDoNothing()
        .returning({ id: webhookKeys.id });
      if (row !== undefined)
        created.set(target, { keyId: row.id, signingSecret: key.secret });
    }
    const existing = await this.keyIdsOfIn(executor, ruleId);
    const keys = new Map<string, ChannelKeyView>();
    for (const target of next) {
      const fresh = created.get(target);
      const keyId = existing.get(target);
      if (fresh !== undefined) keys.set(target, fresh);
      else if (keyId !== undefined)
        keys.set(target, { keyId, signingSecret: null });
    }
    return keys;
  }

  /**
   * Replaces the key of a rule's webhook target with a new one (a channel
   * from before 0.2.0 gets its first key), in the caller's transaction.
   *
   * @returns the new key (its secret is shown once)
   */
  async rotate(
    executor: Executor,
    ruleId: string,
    target: string,
  ): Promise<WebhookSigningKey> {
    const key = { id: newId(), secret: newWebhookSecret() };
    await executor
      .insert(webhookKeys)
      .values({ id: key.id, ruleId, target, secret: key.secret })
      .onConflictDoUpdate({
        target: [webhookKeys.ruleId, webhookKeys.target],
        set: { id: key.id, secret: key.secret, createdAt: sql`now()` },
      });
    return key;
  }

  /** The key that signs a rule's deliveries to `target` (`undefined`: none, the deployment secret). */
  async signingKey(
    ruleId: string,
    target: string,
  ): Promise<WebhookSigningKey | undefined> {
    const [row] = await this.db
      .select({ id: webhookKeys.id, secret: webhookKeys.secret })
      .from(webhookKeys)
      .where(
        and(eq(webhookKeys.ruleId, ruleId), eq(webhookKeys.target, target)),
      )
      .limit(1);
    return row;
  }

  /**
   * The key a test notification to `target` is signed with: the newest key
   * of a rule of the organization with that webhook target.
   */
  async signingKeyOfOrg(
    orgId: string,
    target: string,
  ): Promise<WebhookSigningKey | undefined> {
    const [row] = await this.db
      .select({ id: webhookKeys.id, secret: webhookKeys.secret })
      .from(webhookKeys)
      .innerJoin(alertRules, eq(alertRules.id, webhookKeys.ruleId))
      .where(and(eq(alertRules.orgId, orgId), eq(webhookKeys.target, target)))
      .orderBy(desc(webhookKeys.createdAt))
      .limit(1);
    return row;
  }

  /** Whether a rule of the organization has `target` as a webhook channel. */
  async isChannelOfOrg(orgId: string, target: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(
        and(
          eq(alertRules.orgId, orgId),
          sql`${alertRules.channels} @> ${JSON.stringify([{ type: 'webhook', target }])}::jsonb`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async keyIdsOfIn(
    executor: Executor,
    ruleId: string,
  ): Promise<Map<string, string>> {
    const rows = await executor
      .select({ target: webhookKeys.target, id: webhookKeys.id })
      .from(webhookKeys)
      .where(eq(webhookKeys.ruleId, ruleId));
    return new Map(rows.map((row) => [row.target, row.id]));
  }
}
