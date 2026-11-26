import {
  type AlertDomain,
  type AlertSeverity,
  compareAlertSeverity,
  isSeverityAtLeast,
} from '@darmawanweb/ais-its-contracts/domain';

/**
 * Which vessels a rule may match: `org` = vessels of the rule's organization
 * (spec §8.5, tenant-private), `all` = every vessel (rules of `authority` /
 * `super_admin` principals: "authority-org rules may match any vessel").
 */
export type RuleScope = 'org' | 'all';

/** The criteria of an alert rule (`alert_rules`). Empty lists match everything. */
export interface RuleCriteria {
  readonly orgId: string;
  readonly scope: RuleScope;
  readonly enabled: boolean;
  /** Alert types (open vocabulary, e.g. `ews`, `collision`); empty = any type. */
  readonly types: readonly string[];
  /** Analytics domains; empty = any domain. */
  readonly domains: readonly AlertDomain[];
  readonly minSeverity: AlertSeverity;
  /** Vessels by MMSI (the alert's vessel or its related vessel); empty = any vessel. */
  readonly mmsi: readonly number[];
  /** Zones; empty = any zone (also alerts without zone). */
  readonly zoneIds: readonly string[];
}

/** What a rule is matched against: the alert and the owners of its vessels. */
export interface AlertFacts {
  readonly type: string;
  readonly domain: AlertDomain;
  readonly severity: AlertSeverity;
  readonly mmsi: number;
  readonly relatedMmsi: number | null;
  readonly zoneId: string | null;
  /** Owner organization of `mmsi` (FLEET projection), `null` when unknown. */
  readonly vesselOrgId: string | null;
  /** Owner organization of `relatedMmsi`, `null` when unknown or absent. */
  readonly relatedVesselOrgId: string | null;
}

/**
 * Decides whether an alert rule matches an alert (spec §13.9: "rules match by
 * type/domain, severity, vessel, zone and org").
 *
 * All conditions must hold (logical AND), and an empty list does not
 * restrict:
 * 1. the rule is enabled;
 * 2. organization: a rule of scope `org` matches only alerts whose vessel or
 *    related vessel belongs to the rule's organization; scope `all` matches
 *    any vessel;
 * 3. type: `types` is empty or contains the alert type;
 * 4. domain: `domains` is empty or contains the alert domain;
 * 5. severity: the alert severity is at least `minSeverity`
 *    (`info < warning < critical`);
 * 6. vessel: `mmsi` is empty or contains the alert's MMSI or related MMSI;
 * 7. zone: `zoneIds` is empty or contains the alert's zone.
 *
 * @method notify.alert_rule_matching
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9 and §8.5
 * @param rule - the rule criteria
 * @param alert - the alert and the owners of its vessels
 * @returns `true` when the rule matches
 */
export function ruleMatchesAlert(
  rule: RuleCriteria,
  alert: AlertFacts,
): boolean {
  if (!rule.enabled) return false;
  if (
    rule.scope === 'org' &&
    alert.vesselOrgId !== rule.orgId &&
    alert.relatedVesselOrgId !== rule.orgId
  ) {
    return false;
  }
  if (rule.types.length > 0 && !rule.types.includes(alert.type)) return false;
  if (rule.domains.length > 0 && !rule.domains.includes(alert.domain))
    return false;
  if (!isSeverityAtLeast(alert.severity, rule.minSeverity)) return false;
  if (
    rule.mmsi.length > 0 &&
    !rule.mmsi.includes(alert.mmsi) &&
    (alert.relatedMmsi === null || !rule.mmsi.includes(alert.relatedMmsi))
  ) {
    return false;
  }
  if (
    rule.zoneIds.length > 0 &&
    (alert.zoneId === null || !rule.zoneIds.includes(alert.zoneId))
  ) {
    return false;
  }
  return true;
}

/** The latest notification of one alert through one rule. */
export interface LastNotification {
  readonly at: Date;
  readonly severity: AlertSeverity;
}

/**
 * Per-rule quiet period (spec §13.9). After a rule notified an alert, further
 * occurrences of the same alert (same dedup key while unresolved) are not
 * notified again through that rule for `quietMinutes` — unless the severity
 * rose above the last notified severity: escalations always notify. Other
 * alerts (other vessels, zones or conditions) are never held back, so a quiet
 * period cannot hide a new incident. `quietMinutes = 0` disables it.
 *
 * @method notify.rule_quiet_period
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9 — "per-rule quiet period"
 * @param quietMinutes - the rule's quiet period, minutes (≥ 0)
 * @param last - the rule's latest notification of this alert, if any
 * @param severity - the alert's current severity
 * @param now - evaluation time
 * @returns `true` when the notification is suppressed
 */
export function isWithinQuietPeriod(
  quietMinutes: number,
  last: LastNotification | undefined,
  severity: AlertSeverity,
  now: Date,
): boolean {
  if (quietMinutes <= 0 || last === undefined) return false;
  if (compareAlertSeverity(severity, last.severity) > 0) return false;
  return now.getTime() - last.at.getTime() < quietMinutes * 60_000;
}
