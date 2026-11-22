import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { ForbiddenError } from '@darmawanweb/ais-its-nest';
import { type Principal, UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { describe, expect, it } from 'vitest';

import {
  actsAsAuthorityOf,
  assertRuleScope,
  defaultRuleScope,
  type ScopeChange,
} from './rule-scope.js';

const AUTHORITY_ORG = '0193a3c0-0000-7000-8000-00000000000a';
const SHIPPING_ORG = '0193a3c0-0000-7000-8000-00000000000b';

function user(roles: Role[], orgId: string | null): UserPrincipal {
  return new UserPrincipal({
    id: '0193a3c0-0000-7000-8000-0000000000aa',
    sessionId: '0193a3c0-0000-7000-8000-0000000000ab',
    orgId,
    roles,
    email: 'user@example.com',
    name: 'User',
  });
}

/** The refusal code of a scope change, `undefined` when it is allowed. */
function refusal(
  change: ScopeChange,
  principal: Principal,
): string | undefined {
  try {
    assertRuleScope(change, principal);
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenError);
    return (error as ForbiddenError).code;
  }
  return undefined;
}

describe('rule scope', () => {
  const authority = user(['authority'], AUTHORITY_ORG);
  const superAdmin = user(['super_admin'], AUTHORITY_ORG);
  const fleetManager = user(['fleet_manager'], SHIPPING_ORG);
  const authorityOrgAdmin = user(['org_admin'], AUTHORITY_ORG);

  it('recognizes authority organizations by the authority role in the rule organization', () => {
    expect(actsAsAuthorityOf(authority, AUTHORITY_ORG)).toBe(true);
    expect(actsAsAuthorityOf(authority, SHIPPING_ORG)).toBe(false);
    expect(actsAsAuthorityOf(superAdmin, AUTHORITY_ORG)).toBe(false);
    expect(
      actsAsAuthorityOf(
        user(['super_admin', 'authority'], AUTHORITY_ORG),
        AUTHORITY_ORG,
      ),
    ).toBe(true);
  });

  it('defaults to all only for the rules of the authority organization', () => {
    expect(defaultRuleScope(authority, AUTHORITY_ORG)).toBe('all');
    expect(defaultRuleScope(superAdmin, SHIPPING_ORG)).toBe('org');
    expect(defaultRuleScope(superAdmin, AUTHORITY_ORG)).toBe('org');
    expect(defaultRuleScope(fleetManager, SHIPPING_ORG)).toBe('org');
  });

  it('lets only authority members give a rule scope all', () => {
    const create = {
      orgId: AUTHORITY_ORG,
      current: undefined,
      next: 'all',
    } as const;
    expect(refusal(create, authority)).toBeUndefined();
    expect(refusal(create, authorityOrgAdmin)).toBe('RULE_SCOPE_FORBIDDEN');
    // A super_admin acting for a shipping company cannot widen its rule.
    expect(
      refusal({ orgId: SHIPPING_ORG, current: 'org', next: 'all' }, superAdmin),
    ).toBe('RULE_SCOPE_FORBIDDEN');
  });

  it('guards every change of a rule that watches every vessel', () => {
    const keep = { orgId: AUTHORITY_ORG, current: 'all', next: 'all' } as const;
    const narrow = {
      orgId: AUTHORITY_ORG,
      current: 'all',
      next: 'org',
    } as const;
    expect(refusal(keep, authorityOrgAdmin)).toBe('RULE_SCOPE_FORBIDDEN');
    expect(refusal(narrow, authorityOrgAdmin)).toBe('RULE_SCOPE_FORBIDDEN');
    expect(refusal(keep, authority)).toBeUndefined();
    expect(refusal(keep, superAdmin)).toBeUndefined();
    // Fleet-scoped rules stay with their organization's members.
    expect(
      refusal(
        { orgId: SHIPPING_ORG, current: 'org', next: 'org' },
        fleetManager,
      ),
    ).toBeUndefined();
  });
});
