import { ForbiddenError } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';

import type { RuleScope } from '../../domain/alert-rules.js';

/**
 * The principal acts in `orgId` with the `authority` role. Roles in the
 * access token are those of the active organization (spec §8.2), and auth
 * grants `authority` only in organizations of kind `authority`, so this
 * proves that `orgId` is an authority organization — the only kind whose
 * rules may match any vessel. `super_admin` alone proves nothing about the
 * organization: a platform admin acting for a shipping company creates that
 * company's (fleet-scoped) rules.
 */
export function actsAsAuthorityOf(
  principal: Principal,
  orgId: string,
): boolean {
  return (
    principal.kind === 'user' &&
    principal.orgId === orgId &&
    principal.roles.includes('authority')
  );
}

/** Scope of a new rule without an explicit one: `all` for authority organizations' rules, else `org`. */
export function defaultRuleScope(
  principal: Principal,
  orgId: string,
): RuleScope {
  return actsAsAuthorityOf(principal, orgId) ? 'all' : 'org';
}

/** A rule's scope before and after a create or update. */
export interface ScopeChange {
  /** The rule's organization. */
  readonly orgId: string;
  /** Scope stored now; `undefined` for a new rule. */
  readonly current: RuleScope | undefined;
  /** Scope after the change. */
  readonly next: RuleScope;
}

/**
 * Who may write a rule whose scope is or becomes `all` (it receives the
 * alerts of every tenant's vessels, spec §8.5):
 * - giving a rule scope `all` (create, or `org` → `all`) needs the authority
 *   role in the rule's own organization ({@link actsAsAuthorityOf});
 * - any change of a rule that has scope `all` — its channels, criteria or
 *   scope — needs that too, or `super_admin` (who sees every alert anyway):
 *   other members of the organization could otherwise redirect the
 *   cross-tenant feed to their own channels.
 *
 * Deleting a rule is not a change of its feed and is not restricted here.
 *
 * @throws {ForbiddenError} `RULE_SCOPE_FORBIDDEN`
 */
export function assertRuleScope(
  change: ScopeChange,
  principal: Principal,
): void {
  const authority = actsAsAuthorityOf(principal, change.orgId);
  if (change.next === 'all' && change.current !== 'all' && !authority) {
    throw new ForbiddenError(
      'Only rules of an authority organization, written by its authority members, may watch every vessel',
      { code: 'RULE_SCOPE_FORBIDDEN' },
    );
  }
  const platformAdmin = principal.kind === 'user' && principal.isPlatformAdmin;
  if (change.current === 'all' && !authority && !platformAdmin) {
    throw new ForbiddenError(
      'Only authority members of the organization may change a rule that watches every vessel',
      { code: 'RULE_SCOPE_FORBIDDEN' },
    );
  }
}
