import {
  PositionsBatchSchema,
  type RealtimePosition,
  type RealtimeSafetyState,
  SafetyStatesBatchSchema,
} from '@darmawanweb/ais-its-contracts/realtime';
import { describe, expect, it } from 'vitest';

import { LatestPerVesselBatch, RealtimeBatcher } from './realtime-batcher.js';

const TILE_A = 'tile:6:51:31';
const TILE_B = 'tile:6:52:31';
const AT = new Date('2026-11-21T08:00:01Z');

function position(
  mmsi: number,
  time: string,
  overrides: Partial<RealtimePosition> = {},
): RealtimePosition {
  return {
    mmsi,
    time,
    lat: 1.1,
    lon: 104.1,
    sog: 8.5,
    cog: 90,
    hdg: 91,
    navstatus: 0,
    predictedNavstatus: 0,
    source: 'primary',
    ...overrides,
  };
}

function safety(mmsi: number, time: string): RealtimeSafetyState {
  return {
    mmsi,
    time,
    lat: 1.1,
    lon: 104.1,
    ewsStatus: 3,
    collisionRisk: 'none',
    closestEncounter: null,
  };
}

describe('LatestPerVesselBatch (notify.realtime_batching)', () => {
  it('keeps the newest item of every vessel per room', () => {
    const batch = new LatestPerVesselBatch<RealtimePosition>();
    batch.add(TILE_A, position(525005223, '2026-11-21T08:00:00.000Z'));
    batch.add(
      TILE_A,
      position(525005223, '2026-11-21T08:00:00.500Z', { sog: 9 }),
    );
    batch.add(
      TILE_A,
      position(525005223, '2026-11-21T08:00:00.200Z', { sog: 1 }),
    );
    batch.add(TILE_A, position(525005224, '2026-11-21T08:00:00.100Z'));

    const drained = batch.drain();

    expect(drained.get(TILE_A)).toEqual([
      position(525005223, '2026-11-21T08:00:00.500Z', { sog: 9 }),
      position(525005224, '2026-11-21T08:00:00.100Z'),
    ]);
  });

  it('lets the last item win for equal times', () => {
    const batch = new LatestPerVesselBatch<RealtimePosition>();
    batch.add(TILE_A, position(525005223, '2026-11-21T08:00:00Z', { sog: 1 }));
    batch.add(TILE_A, position(525005223, '2026-11-21T08:00:00Z', { sog: 2 }));

    expect(batch.drain().get(TILE_A)?.[0]?.sog).toBe(2);
  });

  it('starts an empty window after a drain', () => {
    const batch = new LatestPerVesselBatch<RealtimePosition>();
    batch.add(TILE_A, position(525005223, '2026-11-21T08:00:00Z'));
    expect(batch.roomCount).toBe(1);

    batch.drain();

    expect(batch.roomCount).toBe(0);
    expect(batch.drain().size).toBe(0);
  });
});

describe('RealtimeBatcher (notify.realtime_batching)', () => {
  it('batches positions and safety states per tile room with the latest item per vessel', () => {
    const batcher = new RealtimeBatcher();
    batcher.addPosition(TILE_A, position(525005223, '2026-11-21T08:00:00Z'));
    batcher.addPosition(
      TILE_A,
      position(525005223, '2026-11-21T08:00:00.800Z', { lat: 1.2 }),
    );
    batcher.addPosition(TILE_B, position(525005224, '2026-11-21T08:00:00Z'));
    batcher.addSafetyState(TILE_A, safety(525005223, '2026-11-21T08:00:00Z'));

    const batches = batcher.flushTiles(AT);

    expect(batches).toEqual([
      {
        room: TILE_A,
        event: 'positions',
        payload: {
          at: AT.toISOString(),
          items: [
            position(525005223, '2026-11-21T08:00:00.800Z', { lat: 1.2 }),
          ],
        },
      },
      {
        room: TILE_B,
        event: 'positions',
        payload: {
          at: AT.toISOString(),
          items: [position(525005224, '2026-11-21T08:00:00Z')],
        },
      },
      {
        room: TILE_A,
        event: 'safety:states',
        payload: {
          at: AT.toISOString(),
          items: [safety(525005223, '2026-11-21T08:00:00Z')],
        },
      },
    ]);
    // The payloads satisfy the contracts schemas of spec §9.
    for (const batch of batches) {
      const schema =
        batch.event === 'positions'
          ? PositionsBatchSchema
          : SafetyStatesBatchSchema;
      expect(schema.safeParse(batch.payload).success).toBe(true);
    }
  });

  it('collects tile:all separately from the tile windows', () => {
    const batcher = new RealtimeBatcher();
    batcher.addPosition(TILE_A, position(525005223, '2026-11-21T08:00:00Z'));
    batcher.addPosition(TILE_B, position(525005224, '2026-11-21T08:00:00Z'));

    expect(batcher.flushTiles(AT).map((batch) => batch.room)).toEqual([
      TILE_A,
      TILE_B,
    ]);
    const all = batcher.flushAll(AT);

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ room: 'tile:all', event: 'positions' });
    expect(all[0]?.payload.items.map((item) => item.mmsi)).toEqual([
      525005223, 525005224,
    ]);
    expect(batcher.flushAll(AT)).toEqual([]);
  });

  it('skips rooms without members when items arrive and when windows end', () => {
    const members = new Set([TILE_A]);
    const batcher = new RealtimeBatcher((room) => members.has(room));
    batcher.addPosition(TILE_A, position(525005223, '2026-11-21T08:00:00Z'));
    batcher.addPosition(TILE_B, position(525005224, '2026-11-21T08:00:00Z'));
    // TILE_A's last member leaves before the window ends.
    batcher.addSafetyState(TILE_A, safety(525005223, '2026-11-21T08:00:00Z'));
    members.delete(TILE_A);

    expect(batcher.flushTiles(AT)).toEqual([]);
    expect(batcher.flushAll(AT)).toEqual([]);
  });

  it('emits nothing for an empty window', () => {
    expect(new RealtimeBatcher().flushTiles(AT)).toEqual([]);
  });
});
