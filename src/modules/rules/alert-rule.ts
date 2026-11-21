import type {
  AlertDomain,
  AlertSeverity,
  Locale,
  NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import { ForbiddenError } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';

import type { RuleCriteria, RuleScope } from '../../domain/alert-rules.js';

/** One delivery channel of a rule: `{ type, target }` (spec §13.9). */
export interface RuleChannel {
  readonly type: NotificationChannel;
  /** E-mail address, Telegram chat id / @channel, or webhook URL. */
  readonly target: string;
}

/** An alert rule of an organization (`alert_rules` row). */
export interface AlertRule extends RuleCriteria {
  readonly id: string;
  readonly createdBy: string;
  readonly name: string;
  readonly channels: readonly RuleChannel[];
  readonly locale: Locale;
  readonly quietMinutes: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields of a rule a create or update may set. */
export interface AlertRuleFields {
  readonly name: string;
  readonly scope: RuleScope;
  readonly types: readonly string[];
  readonly domains: readonly AlertDomain[];
  readonly minSeverity: AlertSeverity;
  readonly mmsi: readonly number[];
  readonly zoneIds: readonly string[];
  readonly channels: readonly RuleChannel[];
  readonly locale: Locale;
  readonly quietMinutes: number;
  readonly enabled: boolean;
}

/** Which organizations' rules a principal manages (tenant-private, spec §8.5). */
export type RuleTenancy =
  { readonly kind: 'all' } | { readonly kind: 'org'; readonly orgId: string };

/** Filters of `GET /alert-rules`. */
export interface AlertRuleFilter {
  readonly orgId?: string | undefined;
  readonly enabled?: boolean | undefined;
}

/** Platform administrators manage every organization's rules, others their active one's. */
export function ruleTenancyOf(principal: Principal): RuleTenancy | null {
  if (principal.kind === 'user' && principal.isPlatformAdmin) return { kind: 'all' };
  return principal.orgId === null ? null : { kind: 'org', orgId: principal.orgId };
}

/**
 * The rules (and so deliveries) a principal manages.
 *
 * @throws {ForbiddenError} `ORGANIZATION_REQUIRED` without an active organization
 */
export function requireRuleTenancy(principal: Principal): RuleTenancy {
  const tenancy = ruleTenancyOf(principal);
  if (tenancy === null) {
    throw new ForbiddenError('Select an organization to manage alert rules', {
      code: 'ORGANIZATION_REQUIRED',
    });
  }
  return tenancy;
}
