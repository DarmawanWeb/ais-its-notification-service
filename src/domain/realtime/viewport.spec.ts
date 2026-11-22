import {
  lonLatToTile,
  REALTIME_TILE_ZOOM,
  tileRoom,
} from '@darmawanweb/ais-its-contracts/realtime';
import { describe, expect, it } from 'vitest';

import { planViewport } from './viewport.js';

describe('planViewport (notify.realtime_viewport_rooms)', () => {
  it('joins the zoom-6 tiles covering a small box', () => {
    const plan = planViewport(new Set(), [103.5, 0.8, 104.5, 1.5]);
    const corner = lonLatToTile(103.5, 1.5, REALTIME_TILE_ZOOM);

    expect(plan.mode).toBe('tiles');
    expect(plan.tileCount).toBe(plan.rooms.length);
    expect(plan.rooms).toContain(tileRoom(corner.x, corner.y));
    expect(plan.join).toEqual(plan.rooms);
    expect(plan.leave).toEqual([]);
  });

  it('keeps rooms already joined and leaves the uncovered ones', () => {
    const first = planViewport(new Set(), [100, 0.8, 104.5, 1.5]);
    const moved = planViewport(new Set(first.rooms), [104.4, 0.8, 110.5, 1.5]);

    const kept = first.rooms.filter((room) => moved.rooms.includes(room));
    expect(kept.length).toBeGreaterThan(0);
    expect(moved.leave.length).toBeGreaterThan(0);
    expect(moved.join.some((room) => kept.includes(room))).toBe(false);
    expect(moved.leave).toEqual(
      first.rooms.filter((room) => !moved.rooms.includes(room)),
    );
  });

  it('switches to tile:all above 64 tiles and leaves the tile rooms', () => {
    const tiles = planViewport(new Set(), [103.5, 0.8, 104.5, 1.5]);
    // 80°E–150°E × 20°S–20°N covers 13 × 8 = 104 zoom-6 tiles.
    const all = planViewport(new Set(tiles.rooms), [80, -20, 150, 20]);

    expect(all).toMatchObject({
      mode: 'all',
      rooms: ['tile:all'],
      join: ['tile:all'],
      tileCount: 0,
    });
    expect(all.leave).toEqual(tiles.rooms);
  });

  it('refuses an inverted box', () => {
    expect(() => planViewport(new Set(), [104.5, 0.8, 103.5, 1.5])).toThrow(
      RangeError,
    );
  });
});
