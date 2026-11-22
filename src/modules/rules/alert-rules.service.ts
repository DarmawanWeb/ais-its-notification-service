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

/** Use cases of alert rules: tenancy, scope rules, channel checks and the audit trail. */
@Injectable()
export class AlertRulesService {
  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly channels: ChannelPolicy,
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
  ): Promise<AlertRule> {
    const orgId = owningOrg(input.orgId, principal);
    const scope = input.scope ?? defaultRuleScope(principal, orgId);
    assertRuleScope({ orgId, current: undefined, next: scope }, principal);
    this.channels.assertUsable(input.channels, 'channels');
    const rule = await this.rules.insert({
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
    });
    await this.record('alert_rule.create', rule, principal, request, {
      scope: rule.scope,
    });
    return rule;
  }

  /** A rule the principal manages, else `404 ALERT_RULE_NOT_FOUND`. */
  async get(id: string, principal: Principal): Promise<AlertRule> {
    const rule = await this.rules.findById(id, requireRuleTenancy(principal));
    if (rule === undefined) throw ruleNotFound(id);
    return rule;
  }

  /** One page of the rules the principal manages, newest first. */
  async list(
    filter: AlertRuleFilter,
    page: PageQuery,
    principal: Principal,
  ): Promise<Paginated<AlertRule>> {
    if (filter.orgId !== undefined) assertOrgAccess(principal, filter.orgId);
    const { rows, total } = await this.rules.list(
      filter,
      requireRuleTenancy(principal),
      page,
    );
    return toPaginated(rows, page, total);
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
  ): Promise<AlertRule> {
    const fields = changedFields(changes);
    for (let attempt = 1; ; attempt += 1) {
      const current = await this.get(id, principal);
      if (fields.length === 0) return current;
      assertRuleScope(
        {
          orgId: current.orgId,
          current: current.scope,
          next: changes.scope ?? current.scope,
        },
        principal,
      );
      if (changes.channels !== undefined) {
        this.channels.assertUsable(changes.channels, 'channels');
      }
      const rule = await this.rules.update(
        id,
        requireRuleTenancy(principal),
        current.scope,
        changes,
      );
      if (rule !== undefined) {
        await this.record('alert_rule.update', rule, principal, request, {
          fields,
        });
        return rule;
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

function ruleNotFound(id: string): DomainError {
  return new DomainError('ALERT_RULE_NOT_FOUND', {
    detail: `No alert rule with id ${id}`,
    extra: { id },
  });
}
