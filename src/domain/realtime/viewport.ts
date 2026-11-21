import type { BBox } from '@darmawanweb/ais-its-contracts/domain';
import {
  REALTIME_MAX_TILES,
  REALTIME_TILE_ZOOM,
  roomsForViewport,
} from '@darmawanweb/ais-its-contracts/realtime';

/** Room changes of a `viewport:set`. */
export interface ViewportPlan {
  /** `tiles`: zoom-6 tile rooms; `all`: `tile:all` (more than 64 tiles). */
  readonly mode: 'tiles' | 'all';
  /** Rooms of the new viewport. */
  readonly rooms: readonly string[];
  /** Rooms to join (not joined yet). */
  readonly join: readonly string[];
  /** Previous viewport rooms to leave. */
  readonly leave: readonly string[];
  /** Tile rooms of the new viewport (0 for `tile:all`). */
  readonly tileCount: number;
}

/**
 * Plans the rooms of a map viewport (spec §9): the slippy-map tiles at zoom
 * {@link REALTIME_TILE_ZOOM} covering the box (contracts tile math), or
 * `tile:all` when more than {@link REALTIME_MAX_TILES} tiles would be needed.
 * Rooms of the previous viewport that the new one does not cover are left;
 * rooms already joined are kept, so their batches are not interrupted.
 *
 * @param current - viewport rooms the connection is in
 * @param bbox - `[minLon, minLat, maxLon, maxLat]`
 * @throws RangeError for an inverted or antimeridian-crossing box
 */
export function planViewport(current: ReadonlySet<string>, bbox: BBox): ViewportPlan {
  const viewport = roomsForViewport(bbox);
  const next = new Set(viewport.rooms);
  return {
    mode: viewport.mode,
    rooms: [...next],
    join: [...next].filter((room) => !current.has(room)),
    leave: [...current].filter((room) => !next.has(room)),
    tileCount: viewport.mode === 'tiles' ? next.size : 0,
  };
}
