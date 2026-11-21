import {
  type PageQuery,
  type Paginated,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { DomainError, ForbiddenError } from '@darmawanweb/ais-its-nest';
import { type AuditRequest, AuditService } from '@darmawanweb/ais-its-nest/audit';
import { assertOrgAccess, type Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import type { RuleScope } from '../../domain/alert-rules.js';
import { ChannelPolicy } from '../deliveries/channels/channel-policy.js';
import {
  type AlertRule,
  type AlertRuleFields,
  type AlertRuleFilter,
  requireRuleTenancy,
} from './alert-rule.js';
import { AlertRulesRepository } from './alert-rules.repository.js';

/** Input of a new rule (unset fields take their defaults). */
export type CreateAlertRuleInput = Partial<Omit<AlertRuleFields, 'name' | 'channels'>> &
  Pick<AlertRuleFields, 'name' | 'channels'> & { readonly orgId?: string | undefined };

/** Use cases of alert rules: tenancy, scope rules, channel checks and the audit trail. */
@Injectable()
export class AlertRulesService {
  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly channels: ChannelPolicy,
    private readonly audit: AuditService,
  ) {}

  /** Creates a rule in the active organization (super_admin: any organization). */
  async create(
    input: CreateAlertRuleInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<AlertRule> {
    const orgId = owningOrg(input.orgId, principal);
    const scope = input.scope ?? defaultScope(principal);
    assertScope(scope, principal);
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
    await this.record('alert_rule.create', rule, principal, request, { scope: rule.scope });
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
    const { rows, total } = await this.rules.list(filter, requireRuleTenancy(principal), page);
    return toPaginated(rows, page, total);
  }

  /** Changes a rule; an empty change set returns it unchanged. */
  async update(
    id: string,
    changes: Partial<AlertRuleFields>,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<AlertRule> {
    const current = await this.get(id, principal);
    const defined = definedChanges(changes);
    const fields = Object.keys(defined);
    if (fields.length === 0) return current;
    if (defined.scope !== undefined && defined.scope !== current.scope) {
      assertScope(defined.scope, principal);
    }
    if (defined.channels !== undefined) this.channels.assertUsable(defined.channels, 'channels');
    const rule = await this.rules.update(id, requireRuleTenancy(principal), defined);
    if (rule === undefined) throw ruleNotFound(id);
    await this.record('alert_rule.update', rule, principal, request, { fields });
    return rule;
  }

  /** Deletes a rule and its delivery history. */
  async remove(id: string, principal: Principal, request?: AuditRequest): Promise<void> {
    const rule = await this.rules.delete(id, requireRuleTenancy(principal));
    if (rule === undefined) throw ruleNotFound(id);
    await this.record('alert_rule.delete', rule, principal, request, { name: rule.name });
  }

  private async record(
    action: string,
    rule: AlertRule,
    principal: Principal,
    request: AuditRequest | undefined,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { action, targetType: 'alert_rule', targetId: rule.id, orgId: rule.orgId, meta },
      principal,
      request,
    );
  }
}

/** The organization a new rule belongs to (spec §8.5: rules are tenant-private). */
function owningOrg(requested: string | undefined, principal: Principal): string {
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

/** Authority and super_admin rules watch every vessel by default, others their fleet. */
function defaultScope(principal: Principal): RuleScope {
  return principal.kind === 'user' && principal.hasAuthorityAccess ? 'all' : 'org';
}

/** Scope `all` ("authority-org rules may match any vessel") needs cross-tenant access. */
function assertScope(scope: RuleScope, principal: Principal): void {
  if (scope === 'all' && !(principal.kind === 'user' && principal.hasAuthorityAccess)) {
    throw new ForbiddenError('Only authority and super_admin rules may watch every vessel', {
      code: 'RULE_SCOPE_FORBIDDEN',
    });
  }
}

/** The changes without `undefined` members (absent and undefined mean "keep"). */
function definedChanges(changes: Partial<AlertRuleFields>): Partial<AlertRuleFields> {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as Partial<AlertRuleFields>;
}

function ruleNotFound(id: string): DomainError {
  return new DomainError('ALERT_RULE_NOT_FOUND', {
    detail: `No alert rule with id ${id}`,
    extra: { id },
  });
}
