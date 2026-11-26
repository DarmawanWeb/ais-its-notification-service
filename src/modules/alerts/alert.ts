import type {
  AlertDomain,
  AlertSeverity,
  AlertStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  AUTHORITY_ROOM,
  orgRoom,
  type RealtimeAlert,
} from '@darmawanweb/ais-its-contracts/realtime';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';

/** An alert of the inbox (`alerts` row). */
export interface InboxAlert {
  readonly id: string;
  readonly occurredAt: Date;
  readonly type: string;
  readonly domain: AlertDomain;
  readonly severity: AlertSeverity;
  readonly mmsi: number;
  readonly relatedMmsi: number | null;
  /** Owner of the vessel when stored / last merged. */
  readonly orgId: string | null;
  readonly title: string;
  readonly message: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly zoneId: string | null;
  readonly methodId: string;
  readonly dedupKey: string;
  readonly data: Record<string, unknown>;
  readonly source: string;
  readonly status: AlertStatus;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly occurrences: number;
  readonly lastOccurredAt: Date;
  /** `reason` of the `alert.resolved.v1` that resolved it (`null`: unresolved, or resolved by a user). */
  readonly resolutionReason: string | null;
  /** Envelope id of the `alert.resolved.v1` that resolved it. */
  readonly resolutionEventId: string | null;
  /** `data` of the `alert.resolved.v1` that resolved it (localizable text). */
  readonly resolutionData: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Which alerts a principal sees (spec §8.5): `authority` and `super_admin`
 * see every alert; other roles the alerts whose vessel or related vessel
 * belongs to their active organization (FLEET projection); a principal
 * without an organization sees none.
 */
export type AlertScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'none' };

/** The alert scope of a principal. */
export function alertScopeOf(principal: Principal): AlertScope {
  if (principal.kind === 'user' && principal.hasAuthorityAccess)
    return { kind: 'all' };
  return principal.orgId === null
    ? { kind: 'none' }
    : { kind: 'org', orgId: principal.orgId };
}

/** Filters of `GET /alerts`. */
export interface AlertFilter {
  readonly status?: AlertStatus | undefined;
  readonly type?: string | undefined;
  readonly domain?: AlertDomain | undefined;
  readonly severity?: AlertSeverity | undefined;
  readonly mmsi?: number | undefined;
  /** Inclusive lower bound of `occurred_at`; unbounded when absent. */
  readonly from?: Date | undefined;
  /** Inclusive upper bound of `occurred_at`. */
  readonly to: Date;
}

/** Position of an alert in the inbox order (cursor). */
export interface AlertCursor {
  readonly occurredAt: string;
  readonly id: string;
}

/** Open alert counts (`GET /alerts/summary`). */
export interface AlertSummary {
  readonly total: number;
  readonly bySeverity: Readonly<Record<AlertSeverity, number>>;
  readonly byDomain: Readonly<Record<AlertDomain, number>>;
  readonly byType: Readonly<Record<string, number>>;
}

/** A new inbox alert from the first occurrence of a dedup key. */
export function newInboxAlert(
  alert: AlertRaisedV1,
  source: string,
  orgId: string | null,
): Omit<InboxAlert, 'createdAt' | 'updatedAt'> {
  const occurredAt = new Date(alert.occurredAt);
  return {
    id: alert.id,
    occurredAt,
    type: alert.type,
    domain: alert.domain,
    severity: alert.severity,
    mmsi: alert.mmsi,
    relatedMmsi: alert.relatedMmsi,
    orgId,
    title: alert.title,
    message: alert.message,
    lat: alert.lat,
    lon: alert.lon,
    zoneId: alert.zoneId,
    methodId: alert.methodId,
    dedupKey: alert.dedupKey,
    data: alert.data,
    source,
    status: 'open',
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    occurrences: 1,
    lastOccurredAt: occurredAt,
    resolutionReason: null,
    resolutionEventId: null,
    resolutionData: null,
  };
}

/** The alert as pushed to clients (`alert:raised` / `alert:updated`, contracts `RealtimeAlert`). */
export function toRealtimeAlert(alert: InboxAlert): RealtimeAlert {
  return {
    id: alert.id,
    type: alert.type,
    domain: alert.domain,
    severity: alert.severity,
    status: alert.status,
    mmsi: alert.mmsi,
    relatedMmsi: alert.relatedMmsi,
    title: alert.title,
    message: alert.message,
    lat: alert.lat,
    lon: alert.lon,
    zoneId: alert.zoneId,
    methodId: alert.methodId,
    occurredAt: alert.occurredAt.toISOString(),
    lastOccurredAt: alert.lastOccurredAt.toISOString(),
    occurrences: alert.occurrences,
    data: alert.data,
  };
}

/**
 * Rooms an alert is pushed to (spec §9): `authority` and the organization
 * rooms of the owners of its vessel and related vessel — the same principals
 * that may read it over REST (spec §8.5).
 */
export function alertRooms(ownerOrgIds: Iterable<string | null>): string[] {
  const rooms = new Set<string>([AUTHORITY_ROOM]);
  for (const orgId of ownerOrgIds)
    if (orgId !== null) rooms.add(orgRoom(orgId));
  return [...rooms];
}
