import {
  type AlertSeverity,
  type AlertStatus,
  compareAlertSeverity,
} from '@darmawanweb/ais-its-contracts/domain';

/**
 * The part of a stored inbox alert that an occurrence can change (spec
 * §13.9: alerts with the same `dedup_key` while open are merged).
 */
export interface MergeableAlert {
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly occurrences: number;
  readonly lastOccurredAt: Date;
  readonly title: string;
  readonly message: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly relatedMmsi: number | null;
  readonly zoneId: string | null;
  readonly methodId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
}

/** A new occurrence of the condition (an `alert.raised.v1` with the same `dedupKey`). */
export interface AlertOccurrence {
  readonly severity: AlertSeverity;
  readonly occurredAt: Date;
  readonly title: string;
  readonly message: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly relatedMmsi: number | null;
  readonly zoneId: string | null;
  readonly methodId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Outcome of {@link mergeOccurrence}. */
export interface MergeResult {
  readonly alert: MergeableAlert;
  /** The severity rose above the stored one. */
  readonly escalated: boolean;
  /** An acknowledged alert escalated and is open again. */
  readonly reopened: boolean;
}

/**
 * Merges a new occurrence into the unresolved inbox alert of its dedup key.
 *
 * Rules:
 * - `occurrences` grows by one; `last_occurred_at` is the latest occurrence
 *   time (`occurred_at` of the first occurrence never changes: it is the
 *   hypertable partition key and the cursor order of the inbox);
 * - severity never decreases: it is the maximum of the stored severity and the
 *   occurrence's (`info < warning < critical`);
 * - title, message, position, related vessel, zone, method id and details
 *   follow the newest occurrence; an out-of-order (older) occurrence is
 *   counted and may raise the severity but does not overwrite them;
 * - an `acknowledged` alert whose severity rises is reopened (status `open`,
 *   acknowledgement cleared) so that the escalation is seen; without an
 *   escalation it stays acknowledged.
 *
 * @method notify.alert_dedup_merge
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9 — "alerts with the same
 *   dedup_key while open are merged (occurrences++)"
 * @param current - the stored unresolved alert (`open` or `acknowledged`)
 * @param occurrence - the new occurrence of the same dedup key
 * @returns the merged alert and whether it escalated or reopened
 * @throws RangeError when `current` is resolved (resolved alerts never merge)
 */
export function mergeOccurrence(
  current: MergeableAlert,
  occurrence: AlertOccurrence,
): MergeResult {
  if (current.status === 'resolved') {
    throw new RangeError('A resolved alert does not merge new occurrences');
  }
  const escalated =
    compareAlertSeverity(occurrence.severity, current.severity) > 0;
  const severity = escalated ? occurrence.severity : current.severity;
  const newest =
    occurrence.occurredAt.getTime() >= current.lastOccurredAt.getTime();
  const reopened = escalated && current.status === 'acknowledged';
  const details = newest
    ? {
        title: occurrence.title,
        message: occurrence.message,
        lat: occurrence.lat,
        lon: occurrence.lon,
        relatedMmsi: occurrence.relatedMmsi ?? current.relatedMmsi,
        zoneId: occurrence.zoneId ?? current.zoneId,
        methodId: occurrence.methodId,
        data: occurrence.data,
      }
    : {};
  return {
    alert: {
      ...current,
      ...details,
      severity,
      occurrences: current.occurrences + 1,
      lastOccurredAt: newest ? occurrence.occurredAt : current.lastOccurredAt,
      status: reopened ? 'open' : current.status,
      acknowledgedBy: reopened ? null : current.acknowledgedBy,
      acknowledgedAt: reopened ? null : current.acknowledgedAt,
    },
    escalated,
    reopened,
  };
}

/** A user action on an inbox alert. */
export type AlertAction = 'acknowledge' | 'resolve';

/** The lifecycle fields of an inbox alert. */
export interface AlertLifecycle {
  readonly status: AlertStatus;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
}

/** Outcome of {@link transitionAlert}. */
export type AlertTransition =
  | { readonly changed: true; readonly lifecycle: AlertLifecycle }
  | { readonly changed: false; readonly lifecycle: AlertLifecycle }
  | { readonly rejected: 'ALERT_ALREADY_RESOLVED' };

/**
 * Lifecycle of an inbox alert by users: `open → acknowledged → resolved`,
 * and `open → resolved`. Both actions are idempotent (acknowledging an
 * acknowledged alert or resolving a resolved one changes nothing); a resolved
 * alert cannot be acknowledged. Detectors resolve with
 * {@link resolveByDetector}.
 *
 * @method notify.alert_lifecycle
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9 — `status` open / acknowledged / resolved, `POST /alerts/:id/ack|resolve`
 * @param current - the stored lifecycle fields
 * @param action - `acknowledge` (`POST /alerts/:id/ack`) or `resolve`
 * @param actorId - the user acting
 * @param at - when the action happens
 */
export function transitionAlert(
  current: AlertLifecycle,
  action: AlertAction,
  actorId: string,
  at: Date,
): AlertTransition {
  if (action === 'acknowledge') {
    if (current.status === 'resolved') {
      return { rejected: 'ALERT_ALREADY_RESOLVED' };
    }
    if (current.status === 'acknowledged') {
      return { changed: false, lifecycle: current };
    }
    return {
      changed: true,
      lifecycle: {
        ...current,
        status: 'acknowledged',
        acknowledgedBy: actorId,
        acknowledgedAt: at,
      },
    };
  }
  if (current.status === 'resolved')
    return { changed: false, lifecycle: current };
  return {
    changed: true,
    lifecycle: {
      ...current,
      status: 'resolved',
      resolvedBy: actorId,
      resolvedAt: at,
    },
  };
}

/** The part of an unresolved inbox alert a detector resolution reads. */
export interface ResolvableAlert extends AlertLifecycle {
  /** Latest merged occurrence (event time). */
  readonly lastOccurredAt: Date;
}

/** Outcome of {@link resolveByDetector}. */
export type DetectorResolution =
  | { readonly resolved: true; readonly lifecycle: AlertLifecycle }
  | {
      readonly resolved: false;
      /**
       * `already_resolved`: a user (or an earlier resolution) closed it;
       * `later_occurrence`: it merged an occurrence after the end of the
       * condition (a re-raise), so it stays open.
       */
      readonly ignored: 'already_resolved' | 'later_occurrence';
    };

/**
 * A detector's resolution (`alert.resolved.v1`) of the unresolved (open or
 * acknowledged) inbox alert of its dedup key: the alert becomes `resolved`
 * at the end of the condition (`resolvedAt`, event time) by the system
 * (`resolvedBy` = `null`), keeping its acknowledgement — unless it merged an
 * occurrence later than `resolvedAt` (`lastOccurredAt > resolvedAt`, e.g. a
 * re-raise handled before a redelivered resolution), which keeps it open. A
 * resolution at the exact time of the latest occurrence resolves.
 *
 * @method notify.alert_lifecycle
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9, §18 — resolution events
 * @param current - the stored unresolved alert of the resolution's dedup key
 * @param resolvedAt - `resolvedAt` of the `alert.resolved.v1`
 */
export function resolveByDetector(
  current: ResolvableAlert,
  resolvedAt: Date,
): DetectorResolution {
  if (current.status === 'resolved')
    return { resolved: false, ignored: 'already_resolved' };
  if (current.lastOccurredAt.getTime() > resolvedAt.getTime())
    return { resolved: false, ignored: 'later_occurrence' };
  return {
    resolved: true,
    lifecycle: {
      status: 'resolved',
      acknowledgedBy: current.acknowledgedBy,
      acknowledgedAt: current.acknowledgedAt,
      resolvedBy: null,
      resolvedAt,
    },
  };
}
