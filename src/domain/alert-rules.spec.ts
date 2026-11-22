import { describe, expect, it } from 'vitest';

import {
  type AlertFacts,
  isWithinQuietPeriod,
  type RuleCriteria,
  ruleMatchesAlert,
} from './alert-rules.js';

const ORG_A = '0193a3c0-0000-7000-8000-00000000000a';
const ORG_B = '0193a3c0-0000-7000-8000-00000000000b';
const ZONE = '0193a3c0-0000-7000-8000-0000000000e1';
const OTHER_ZONE = '0193a3c0-0000-7000-8000-0000000000e2';

const rule: RuleCriteria = {
  orgId: ORG_A,
  scope: 'org',
  enabled: true,
  types: [],
  domains: [],
  minSeverity: 'info',
  mmsi: [],
  zoneIds: [],
};

const alert: AlertFacts = {
  type: 'ews',
  domain: 'safety',
  severity: 'warning',
  mmsi: 525005223,
  relatedMmsi: null,
  zoneId: ZONE,
  vesselOrgId: ORG_A,
  relatedVesselOrgId: null,
};

describe('ruleMatchesAlert (notify.alert_rule_matching)', () => {
  it('matches an alert of the own fleet with empty criteria', () => {
    expect(ruleMatchesAlert(rule, alert)).toBe(true);
  });

  it('never matches when disabled', () => {
    expect(ruleMatchesAlert({ ...rule, enabled: false }, alert)).toBe(false);
  });

  describe('organization', () => {
    it('ignores vessels of other or unknown organizations', () => {
      expect(ruleMatchesAlert(rule, { ...alert, vesselOrgId: ORG_B })).toBe(
        false,
      );
      expect(ruleMatchesAlert(rule, { ...alert, vesselOrgId: null })).toBe(
        false,
      );
    });

    it('matches when the related vessel belongs to the organization', () => {
      expect(
        ruleMatchesAlert(rule, {
          ...alert,
          type: 'collision',
          vesselOrgId: ORG_B,
          relatedMmsi: 525005224,
          relatedVesselOrgId: ORG_A,
        }),
      ).toBe(true);
    });

    it('matches every vessel for scope all (authority rules)', () => {
      const authority: RuleCriteria = { ...rule, scope: 'all' };

      expect(
        ruleMatchesAlert(authority, { ...alert, vesselOrgId: ORG_B }),
      ).toBe(true);
      expect(ruleMatchesAlert(authority, { ...alert, vesselOrgId: null })).toBe(
        true,
      );
    });
  });

  it('filters by type and domain (empty lists match all)', () => {
    expect(
      ruleMatchesAlert({ ...rule, types: ['ews', 'collision'] }, alert),
    ).toBe(true);
    expect(ruleMatchesAlert({ ...rule, types: ['geofence'] }, alert)).toBe(
      false,
    );
    expect(ruleMatchesAlert({ ...rule, domains: ['safety'] }, alert)).toBe(
      true,
    );
    expect(
      ruleMatchesAlert({ ...rule, domains: ['surveillance'] }, alert),
    ).toBe(false);
  });

  it('accepts future alert types unknown to the registry', () => {
    expect(
      ruleMatchesAlert(
        { ...rule, types: ['anchor_dragging'] },
        { ...alert, type: 'anchor_dragging' },
      ),
    ).toBe(true);
  });

  it('requires at least the minimum severity (info < warning < critical)', () => {
    expect(ruleMatchesAlert({ ...rule, minSeverity: 'warning' }, alert)).toBe(
      true,
    );
    expect(ruleMatchesAlert({ ...rule, minSeverity: 'critical' }, alert)).toBe(
      false,
    );
    expect(
      ruleMatchesAlert(
        { ...rule, minSeverity: 'critical' },
        { ...alert, severity: 'critical' },
      ),
    ).toBe(true);
  });

  it('filters by vessel, including the related vessel', () => {
    expect(ruleMatchesAlert({ ...rule, mmsi: [525005223] }, alert)).toBe(true);
    expect(ruleMatchesAlert({ ...rule, mmsi: [525009999] }, alert)).toBe(false);
    expect(
      ruleMatchesAlert(
        { ...rule, mmsi: [525005224] },
        { ...alert, relatedMmsi: 525005224 },
      ),
    ).toBe(true);
  });

  it('filters by zone; alerts without zone only match rules without zones', () => {
    expect(ruleMatchesAlert({ ...rule, zoneIds: [ZONE] }, alert)).toBe(true);
    expect(ruleMatchesAlert({ ...rule, zoneIds: [OTHER_ZONE] }, alert)).toBe(
      false,
    );
    expect(
      ruleMatchesAlert(
        { ...rule, zoneIds: [ZONE] },
        { ...alert, zoneId: null },
      ),
    ).toBe(false);
    expect(ruleMatchesAlert(rule, { ...alert, zoneId: null })).toBe(true);
  });

  it('requires every criterion (logical AND)', () => {
    const strict: RuleCriteria = {
      ...rule,
      types: ['ews'],
      domains: ['safety'],
      minSeverity: 'warning',
      mmsi: [525005223],
      zoneIds: [ZONE],
    };

    expect(ruleMatchesAlert(strict, alert)).toBe(true);
    expect(ruleMatchesAlert(strict, { ...alert, severity: 'info' })).toBe(
      false,
    );
    expect(ruleMatchesAlert(strict, { ...alert, zoneId: OTHER_ZONE })).toBe(
      false,
    );
  });
});

describe('isWithinQuietPeriod (notify.rule_quiet_period)', () => {
  const notifiedAt = new Date('2026-11-21T08:00:00Z');
  const last = { at: notifiedAt, severity: 'warning' as const };
  const after = (minutes: number) =>
    new Date(notifiedAt.getTime() + minutes * 60_000);

  it('is off with 0 minutes or without an earlier notification', () => {
    expect(isWithinQuietPeriod(0, last, 'warning', after(1))).toBe(false);
    expect(isWithinQuietPeriod(30, undefined, 'warning', after(1))).toBe(false);
  });

  it('suppresses repeats within the period and releases them after it', () => {
    expect(isWithinQuietPeriod(30, last, 'warning', after(29))).toBe(true);
    expect(isWithinQuietPeriod(30, last, 'info', after(29))).toBe(true);
    expect(isWithinQuietPeriod(30, last, 'warning', after(30))).toBe(false);
  });

  it('never holds back an escalation', () => {
    expect(isWithinQuietPeriod(30, last, 'critical', after(1))).toBe(false);
  });
});
