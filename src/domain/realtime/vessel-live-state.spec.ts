import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type RealtimePosition,
  tileRoomForPosition,
} from '@darmawanweb/ais-its-contracts/realtime';
import { describe, expect, it } from 'vitest';

import { VesselLiveState } from './vessel-live-state.js';

const MMSI = 525005223;

function position(time: string, lon = 104.1, lat = 1.1): RealtimePosition {
  return {
    mmsi: MMSI,
    time,
    lat,
    lon,
    sog: 0.2,
    cog: 45,
    hdg: 47,
    navstatus: 1,
    predictedNavstatus: 1,
    source: 'batam',
  };
}

function safetyState(
  time: string,
  ewsStatus: 0 | 1 | 3 = 1,
): SafetyVesselStateV1 {
  return {
    mmsi: MMSI,
    time,
    ewsStatus,
    pipelineDistanceM: 1_200,
    nearestPipelineZoneId: null,
    collisionRisk: 'none',
    closestEncounter: null,
    methodIds: ['ews.pipeline_distance_status'],
  };
}

describe('VesselLiveState', () => {
  it('places a position in its zoom-6 tile room', () => {
    const state = new VesselLiveState(10);

    const update = state.applyPosition(position('2026-11-21T08:00:00Z'));

    expect(update).toEqual({
      position: position('2026-11-21T08:00:00Z'),
      room: tileRoomForPosition(104.1, 1.1),
      safety: null,
      safetyWasPending: false,
    });
  });

  it('ignores positions that are not newer than the known one', () => {
    const state = new VesselLiveState(10);
    state.applyPosition(position('2026-11-21T08:00:10Z'));

    expect(state.applyPosition(position('2026-11-21T08:00:10Z'))).toBeNull();
    expect(state.applyPosition(position('2026-11-21T08:00:05Z'))).toBeNull();
  });

  it('holds a safety state until the first position, then places it there', () => {
    const state = new VesselLiveState(10);

    expect(state.applySafety(safetyState('2026-11-21T07:59:00Z'))).toEqual({
      state: null,
      room: null,
    });
    const update = state.applyPosition(position('2026-11-21T08:00:00Z'));

    expect(update?.safetyWasPending).toBe(true);
    expect(update?.safety).toMatchObject({
      mmsi: MMSI,
      lat: 1.1,
      lon: 104.1,
      ewsStatus: 1,
    });
  });

  it('pushes the safety state again when the vessel enters another tile', () => {
    const state = new VesselLiveState(10);
    state.applyPosition(position('2026-11-21T08:00:00Z'));
    state.applySafety(safetyState('2026-11-21T08:00:01Z'));

    const sameTile = state.applyPosition(
      position('2026-11-21T08:00:02Z', 104.2),
    );
    const otherTile = state.applyPosition(
      position('2026-11-21T08:00:03Z', 110.5),
    );

    expect(sameTile?.safety).toBeNull();
    expect(otherTile?.room).not.toBe(sameTile?.room);
    expect(otherTile?.safety).toMatchObject({ mmsi: MMSI, lon: 110.5 });
    expect(otherTile?.safetyWasPending).toBe(false);
  });

  it('places a safety state at the latest position and ignores older states', () => {
    const state = new VesselLiveState(10);
    state.applyPosition(position('2026-11-21T08:00:00Z'));

    expect(state.applySafety(safetyState('2026-11-21T08:00:05Z', 0))).toEqual({
      state: {
        mmsi: MMSI,
        time: '2026-11-21T08:00:05Z',
        lat: 1.1,
        lon: 104.1,
        ewsStatus: 0,
        collisionRisk: 'none',
        closestEncounter: null,
      },
      room: tileRoomForPosition(104.1, 1.1),
    });
    expect(state.applySafety(safetyState('2026-11-21T08:00:01Z'))).toBeNull();
  });

  it('returns the latest snapshot of a vessel', () => {
    const state = new VesselLiveState(10);
    expect(state.snapshot(MMSI)).toEqual({ position: null, safety: null });

    state.applyPosition(position('2026-11-21T08:00:00Z'));
    state.applySafety(safetyState('2026-11-21T08:00:01Z'));

    expect(state.snapshot(MMSI)).toMatchObject({
      position: { mmsi: MMSI, time: '2026-11-21T08:00:00Z' },
      safety: { mmsi: MMSI, ewsStatus: 1, lat: 1.1 },
    });
  });

  it('evicts the least recently updated vessels beyond its capacity', () => {
    const state = new VesselLiveState(2);
    for (const mmsi of [525000001, 525000002, 525000003]) {
      state.applyPosition({ ...position('2026-11-21T08:00:00Z'), mmsi });
    }

    expect(state.size).toBe(2);
    expect(state.snapshot(525000001).position).toBeNull();
    expect(state.snapshot(525000003).position).not.toBeNull();
  });

  it('refuses a capacity below 1', () => {
    expect(() => new VesselLiveState(0)).toThrow(RangeError);
  });
});
