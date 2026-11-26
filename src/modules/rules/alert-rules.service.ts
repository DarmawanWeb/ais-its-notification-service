import {
  type PageQuery,
  type Paginated,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
} from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import {
  assertOrgAccess,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { ChannelPolicy } from '../deliveries/channels/channel-policy.js';
import {
  type RuleChannelKeys,
  WebhookKeysRepository,
  webhookTargets,
} from '../deliveries/channels/webhook-keys.repository.js';
import {
  type AlertRule,
  type AlertRuleChanges,
  type AlertRuleFields,
  type AlertRuleFilter,
  requireRuleTenancy,
} from './alert-rule.js';
import { AlertRulesRepository } from './alert-rules.repository.js';
import { assertRuleScope, defaultRuleScope } from './rule-scope.js';

/** Attempts of an update that races with a concurrent scope change. */
const UPDATE_ATTEMPTS = 3;

/** Input of a new rule (unset fields take their defaults). */
export type CreateAlertRuleInput = Partial<
  Omit<AlertRuleFields, 'name' | 'channels'>
> &
  Pick<AlertRuleFields, 'name' | 'channels'> & {
    readonly orgId?: string | undefined;
  };

/** A rule with the keys of its webhook channels. */
export interface AlertRuleView {
  readonly rule: AlertRule;
  /** By webhook target; a channel from before 0.2.0 has none until rotated. */
  readonly keys: RuleChannelKeys;
}

/**
 * Use cases of alert rules: tenancy, scope rules, channel checks, the signing
 * keys of webhook channels and the audit trail.
 */
@Injectable()
export class AlertRulesService {
  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly channels: ChannelPolicy,
    private readonly webhookKeys: WebhookKeysRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a rule in the active organization (super_admin: any
   * organization). Scope `all` is the default, and allowed, only for rules
   * of an authority organization written by its authority members
   * (`assertRuleScope`).
   */
  async create(
    input: CreateAlertRuleInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<AlertRuleView> {
    const orgId = owningOrg(input.orgId, principal);
    const scope = input.scope ?? defaultRuleScope(principal, orgId);
    assertRuleScope({ orgId, current: undefined, next: scope }, principal);
    this.channels.assertUsable(input.channels, 'channels');
    // Every webhook channel gets its own signing key, shown once in the response.
    const view = await this.rules.transaction(async (tx) => {
      const rule = await this.rules.insert(
        {
          id: newId(),
          orgId,
          createdBy: principal.id,
          name: input.name,
          scope,
          types: input.types ?? [],
          domains: input.domains ?? [],
          minSeverity: input.minSeverity ?? 'info',
          mmsi: input.mmsi ?? [],
          zoneIds: input.zoneIds ?? [],
          channels: input.channels,
          locale: input.locale ?? 'id',
          quietMinutes: input.quietMinutes ?? 0,
          enabled: input.enabled ?? true,
        },
        tx,
      );
      const keys = await this.webhookKeys.reconcile(
        tx,
        rule.id,
        [],
        webhookTargets(rule.channels),
      );
      return { rule, keys };
    });
    await this.record('alert_rule.create', view.rule, principal, request, {
      scope: view.rule.scope,
    });
    return view;
  }

  /** A rule the principal manages, else `404 ALERT_RULE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<AlertRule> {
    const rule = await this.rules.findById(id, requireRuleTenancy(principal));
    if (rule === undefined) throw ruleNotFound(id);
    return rule;
  }

  /** {@link get} with the key ids of the webhook channels. */
  async view(id: string, principal: Principal): Promise<AlertRuleView> {
    const rule = await this.get(id, principal);
    return { rule, keys: await this.keysOf(rule) };
  }

  /** One page of the rules the principal manages, newest first. */
  async list(
    filter: AlertRuleFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<AlertRuleView>> {
    if (filter.orgId !== undefined) assertOrgAccess(principal, filter.orgId);
    const { rows, total } = await this.rules.list(
      filter,
      requireRuleTenancy(principal),
      page,
    );
    const keyIds = await this.webhookKeys.keyIdsOf(rows.map((row) => row.id));
    return toPaginated(
      rows.map((rule) => ({
        rule,
        keys: keyViews(keyIds.get(rule.id)),
      })),
      page,
      total,
    );
  }

  /**
   * Replaces the signing key of the webhook channel at `index` (a channel
   * from before 0.2.0 gets its first own key): the new secret is in the
   * response only; deliveries sent from now on, pending ones included, use
   * it. Authorized like a change of the rule.
   *
   * @throws {DomainError} `404 ALERT_RULE_NOT_FOUND`, `404 RULE_CHANNEL_NOT_FOUND`, `422 RULE_CHANNEL_NOT_WEBHOOK`
   */
  async rotateSecret(
    id: string,
    index: number,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<AlertRuleView> {
    const tenancy = requireRuleTenancy(principal);
    const view = await this.rules.transaction(async (tx) => {
      const rule = await this.rules.lock(tx, id, tenancy);
      if (rule === undefined) throw ruleNotFound(id);
      assertRuleScope(
        { orgId: rule.orgId, current: rule.scope, next: rule.scope },
        principal,
      );
      const channel = rule.channels[index];
      if (channel === undefined) throw channelNotFound(id, index);
      if (channel.type !== 'webhook') throw channelNotWebhook(id, index);
      const key = await this.webhookKeys.rotate(tx, rule.id, channel.target);
      const keyIds = await this.webhookKeys.keyIdsOf([rule.id]);
      const keys = new Map(keyViews(keyIds.get(rule.id)));
      keys.set(channel.target, { keyId: key.id, signingSecret: key.secret });
      return { rule, keys, keyId: key.id };
    });
    await this.record(
      'alert_rule.rotate_secret',
      view.rule,
      principal,
      request,
      { channel: index, keyId: view.keyId },
    );
    return { rule: view.rule, keys: view.keys };
  }

  /**
   * Changes a rule; an empty change set returns it unchanged. Every change of
   * a rule whose scope is or becomes `all` is authorized against the stored
   * scope (`assertRuleScope`); the update applies only while that scope is
   * still stored, otherwise the change is authorized again.
   */
  async update(
    id: string,
    changes: AlertRuleChanges,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<AlertRuleView> {
    const fields = changedFields(changes);
    const tenancy = requireRuleTenancy(principal);
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.get(id, principal);
      if (fields.length === 0)
        return { rule: current, keys: await this.keysOf(current) };
      assertRuleScope(
        {
          orgId: current.orgId,
          current: current.scope,
          next: changes.scope ?? current.scope,
        },
        principal,
      );
      const { channels } = changes;
      if (channels !== undefined) {
        this.channels.assertUsable(channels, 'channels');
      }
      const view =
        channels === undefined
          ? await this.updateRule(id, tenancy, current.scope, changes)
          : // New webhook targets get keys (shown once), removed ones lose theirs.
            await this.rules.transaction(async (tx) => {
              const locked = await this.rules.lock(
                tx,
                id,
                tenancy,
                current.scope,
              );
              if (locked === undefined) return undefined;
              const rule = await this.rules.update(
                id,
                tenancy,
                current.scope,
                changes,
                tx,
              );
              if (rule === undefined) return undefined;
              const keys = await this.webhookKeys.reconcile(
                tx,
                id,
                webhookTargets(locked.channels),
                webhookTargets(rule.channels),
              );
              return { rule, keys };
            });
      if (view !== undefined) {
        await this.record('alert_rule.update', view.rule, principal, request, {
          fields,
        });
        return view;
      }
      // Deleted (the next read answers 404) or its scope changed meanwhile.
      if (attempt >= UPDATE_ATTEMPTS) {
        throw new ConflictError(
          `Alert rule ${id} changed concurrently, retry`,
          {
            code: 'CONFLICT',
          },
        );
      }
    }
  }

  /** Deletes a rule and its delivery history. */
  async remove(
    id: string,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<void> {
    const rule = await this.rules.delete(id, requireRuleTenancy(principal));
    if (rule === undefined) throw ruleNotFound(id);
    await this.record('alert_rule.delete', rule, principal, request, {
      name: rule.name,
    });
  }

  private async updateRule(
    id: string,
    tenancy: ReturnType<typeof requireRuleTenancy>,
    expectedScope: AlertRule['scope'],
    changes: AlertRuleChanges,
  ): Promise<AlertRuleView | undefined> {
    const rule = await this.rules.update(id, tenancy, expectedScope, changes);
    return rule === undefined
      ? undefined
      : { rule, keys: await this.keysOf(rule) };
  }

  /** The key ids of a rule's webhook channels. */
  private async keysOf(rule: AlertRule): Promise<RuleChannelKeys> {
    const keyIds = await this.webhookKeys.keyIdsOf([rule.id]);
    return keyViews(keyIds.get(rule.id));
  }

  private async record(
    action: string,
    rule: AlertRule,
    principal: Principal,
    request: AuditRequest | undefined,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        targetType: 'alert_rule',
        targetId: rule.id,
        orgId: rule.orgId,
        meta,
      },
      principal,
      request,
    );
  }
}

/** The organization a new rule belongs to (spec §8.5: rules are tenant-private). */
function owningOrg(
  requested: string | undefined,
  principal: Principal,
): string {
  if (requested !== undefined && requested !== principal.orgId) {
    if (!(principal.kind === 'user' && principal.isPlatformAdmin)) {
      throw new ForbiddenError('Rules are created in the active organization', {
        code: 'FORBIDDEN',
      });
    }
    return requested;
  }
  if (principal.orgId === null) {
    throw new ForbiddenError('Select an organization to manage alert rules', {
      code: 'ORGANIZATION_REQUIRED',
    });
  }
  return principal.orgId;
}

/** Names of the fields a change set sets (absent and `undefined` mean "keep"). */
function changedFields(changes: AlertRuleChanges): string[] {
  return Object.entries(changes)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

/** Key ids by target as views without secrets. */
function keyViews(
  keyIds: ReadonlyMap<string, string> | undefined,
): RuleChannelKeys {
  return new Map(
    [...(keyIds ?? [])].map(([target, keyId]) => [
      target,
      { keyId, signingSecret: null },
    ]),
  );
}

function channelNotFound(id: string, index: number): DomainError {
  return new DomainError('RULE_CHANNEL_NOT_FOUND', {
    status: 404,
    title: 'Channel not found',
    detail: `Alert rule ${id} has no channel ${index}`,
    extra: { id, index },
  });
}

function channelNotWebhook(id: string, index: number): DomainError {
  return new DomainError('RULE_CHANNEL_NOT_WEBHOOK', {
    status: 422,
    title: 'Not a webhook channel',
    detail: `Channel ${index} of alert rule ${id} is no webhook: only webhooks have a signing secret`,
    extra: { id, index },
  });
}

function ruleNotFound(id: string): DomainError {
  return new DomainError('ALERT_RULE_NOT_FOUND', {
    detail: `No alert rule with id ${id}`,
    extra: { id },
  });
}
