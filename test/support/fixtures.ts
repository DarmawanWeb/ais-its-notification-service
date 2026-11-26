import {
  type AisPositionRecordedV1,
  type AlertRaisedV1,
  type AlertResolvedV1,
  EVENT_TYPES,
  type SafetyVesselStateV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  makeTestAlertRaised,
  makeTestAlertResolved,
  makeTestVesselSnapshot,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';

import type { TestService } from './test-service.js';

let nextMmsi = 525_100_000 + Math.floor(Math.random() * 800_000);

/** A fresh 9-digit MMSI (tests share the database, so every test uses its own vessels). */
export function uniqueMmsi(): number {
  nextMmsi += 1;
  return nextMmsi;
}

/**
 * Publishes a `fleet.vessel.upserted.v1` snapshot and waits until the
 * `notification-fleet` projection stored it.
 */
export async function registerVessel(
  service: TestService,
  vessel: {
    readonly mmsi: number;
    readonly orgId: string | null;
    readonly name?: string;
  },
): Promise<string> {
  const snapshot = makeTestVesselSnapshot({
    mmsi: vessel.mmsi,
    orgId: vessel.orgId,
    name: vessel.name ?? `KM Test ${vessel.mmsi}`,
    updatedAt: new Date().toISOString(),
  });
  await service.publisher.publishEvent(
    EVENT_TYPES.FLEET_VESSEL_UPSERTED,
    snapshot,
  );
  await waitFor(async () => {
    const { rowCount } = await service.pool.query(
      'SELECT 1 FROM vessels WHERE vessel_id = $1',
      [snapshot.id],
    );
    return rowCount === 1;
  });
  return snapshot.id;
}

/** Pipeline zone of the test alerts. */
const TEST_ZONE_ID = '0193a3c0-0000-7000-8000-0000000000e1';

/**
 * An `alert.raised.v1` payload of the kit (EWS warning by default) for
 * `mmsi`, occurring now, validated with the contracts schema.
 */
export function alertRaised(
  mmsi: number,
  overrides: Partial<AlertRaisedV1> = {},
): AlertRaisedV1 {
  return makeTestAlertRaised({
    mmsi,
    occurredAt: new Date().toISOString(),
    dedupKey: `ews:${mmsi}:${TEST_ZONE_ID}`,
    zoneId: TEST_ZONE_ID,
    ...overrides,
  });
}

/**
 * The `alert.resolved.v1` of the occurrence `raise` (kit fixture): by default
 * the condition ended ten minutes after the raise.
 */
export function alertResolved(
  raise: AlertRaisedV1,
  overrides: Partial<AlertResolvedV1> = {},
): AlertResolvedV1 {
  return makeTestAlertResolved(overrides, raise);
}

/** Publishes an alert as a detector does (envelope id = alert id). */
export async function raiseAlert(
  service: TestService,
  alert: AlertRaisedV1,
): Promise<void> {
  await service.publisher.publishEvent(EVENT_TYPES.ALERT_RAISED, alert, {
    id: alert.id,
  });
}

/** Publishes a resolution as a detector does (envelope id = resolution id). */
export async function resolveAlert(
  service: TestService,
  resolution: AlertResolvedV1,
): Promise<void> {
  await service.publisher.publishEvent(EVENT_TYPES.ALERT_RESOLVED, resolution, {
    id: resolution.id,
  });
}

/** Waits for the inbox alert of a dedup key and returns its row. */
export async function storedAlert(
  service: TestService,
  dedupKey: string,
  predicate: (row: StoredAlertRow) => boolean = () => true,
): Promise<StoredAlertRow> {
  return waitFor(async () => {
    const { rows } = await service.pool.query<StoredAlertRow>(
      `SELECT id, status, severity, occurrences, org_id AS "orgId", title,
              resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
              resolution_reason AS "resolutionReason",
              resolution_event_id AS "resolutionEventId"
         FROM alerts WHERE dedup_key = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [dedupKey],
    );
    const [row] = rows;
    return row !== undefined && predicate(row) ? row : undefined;
  });
}

/** Columns of an inbox alert read by the tests. */
export interface StoredAlertRow {
  readonly id: string;
  readonly status: string;
  readonly severity: string;
  readonly occurrences: number;
  readonly orgId: string | null;
  readonly title: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionReason: string | null;
  readonly resolutionEventId: string | null;
}

/** An `ais.position.recorded.v1` payload. */
export function positionEvent(
  mmsi: number,
  lon: number,
  lat: number,
  time: Date = new Date(),
): AisPositionRecordedV1 {
  return {
    mmsi,
    time: time.toISOString(),
    source: 'primary',
    lat,
    lon,
    sog: 9.5,
    cog: 80,
    hdg: 81,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: 12_000,
    previous: null,
  };
}

/** A `safety.vessel_state.updated.v1` payload. */
export function safetyStateEvent(
  mmsi: number,
  time: Date = new Date(),
  overrides: Partial<SafetyVesselStateV1> = {},
): SafetyVesselStateV1 {
  return {
    mmsi,
    time: time.toISOString(),
    ewsStatus: 1,
    pipelineDistanceM: 1_200,
    nearestPipelineZoneId: null,
    collisionRisk: 'low',
    closestEncounter: { otherMmsi: 525005999, cpaNm: 0.8, tcpaMin: 14 },
    methodIds: ['ews.pipeline_distance_status', 'collision.cpa_tcpa'],
    ...overrides,
  };
}
