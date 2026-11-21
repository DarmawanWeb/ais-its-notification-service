import {
  ALL_TILES_ROOM,
  type PositionsBatch,
  type RealtimePosition,
  type RealtimeSafetyState,
  REALTIME_SERVER_EVENTS,
  type SafetyStatesBatch,
} from '@darmawanweb/ais-its-contracts/realtime';

/** An item of a realtime batch: one vessel at one time. */
export interface VesselItem {
  readonly mmsi: number;
  /** ISO-8601 time of the position or safety state. */
  readonly time: string;
}

/**
 * Items of one batch window per room, keeping only the latest item of every
 * vessel (spec §9: "latest position per vessel in the window"). The latest is
 * the item with the newest `time`; for equal times the last one added wins.
 */
export class LatestPerVesselBatch<T extends VesselItem> {
  private rooms = new Map<string, Map<number, T>>();

  /** Adds an item to the window of `room`. */
  add(room: string, item: T): void {
    let items = this.rooms.get(room);
    if (items === undefined) {
      items = new Map();
      this.rooms.set(room, items);
    }
    const current = items.get(item.mmsi);
    if (current === undefined || Date.parse(item.time) >= Date.parse(current.time)) {
      items.set(item.mmsi, item);
    }
  }

  /** Rooms with items in the current window. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Ends the window: returns the items per room and starts an empty one. */
  drain(): Map<string, T[]> {
    const drained = new Map<string, T[]>();
    for (const [room, items] of this.rooms) drained.set(room, [...items.values()]);
    this.rooms = new Map();
    return drained;
  }
}

/** A batch to emit to one room. */
export type OutgoingBatch =
  | {
      readonly room: string;
      readonly event: typeof REALTIME_SERVER_EVENTS.POSITIONS;
      readonly payload: PositionsBatch;
    }
  | {
      readonly room: string;
      readonly event: typeof REALTIME_SERVER_EVENTS.SAFETY_STATES;
      readonly payload: SafetyStatesBatch;
    };

/** Whether a room currently has members (only those get items). */
export type RoomActivity = (room: string) => boolean;

/**
 * The batching of the realtime gateway (spec §9), free of sockets and timers
 * so that it is unit-testable: positions and safety states are collected per
 * zoom-6 tile room and for `tile:all`; {@link flushTiles} (every 1 s) and
 * {@link flushAll} (every 5 s) end the windows and return the batches to emit,
 * each with the latest item per vessel. Rooms without members are skipped
 * when items arrive and when windows end.
 */
export class RealtimeBatcher {
  private readonly tilePositions = new LatestPerVesselBatch<RealtimePosition>();
  private readonly tileSafety = new LatestPerVesselBatch<RealtimeSafetyState>();
  private readonly allPositions = new LatestPerVesselBatch<RealtimePosition>();
  private readonly allSafety = new LatestPerVesselBatch<RealtimeSafetyState>();

  /** @param isActive - room membership; default every room is active */
  constructor(private readonly isActive: RoomActivity = () => true) {}

  /** Collects a position for its tile room and for `tile:all`. */
  addPosition(tileRoom: string, item: RealtimePosition): void {
    if (this.isActive(tileRoom)) this.tilePositions.add(tileRoom, item);
    if (this.isActive(ALL_TILES_ROOM)) this.allPositions.add(ALL_TILES_ROOM, item);
  }

  /** Collects a safety state for its tile room and for `tile:all`. */
  addSafetyState(tileRoom: string, item: RealtimeSafetyState): void {
    if (this.isActive(tileRoom)) this.tileSafety.add(tileRoom, item);
    if (this.isActive(ALL_TILES_ROOM)) this.allSafety.add(ALL_TILES_ROOM, item);
  }

  /** Ends the tile windows: `positions` then `safety:states` batches per tile room. */
  flushTiles(at: Date): OutgoingBatch[] {
    return this.batches(this.tilePositions, this.tileSafety, at);
  }

  /** Ends the `tile:all` windows. */
  flushAll(at: Date): OutgoingBatch[] {
    return this.batches(this.allPositions, this.allSafety, at);
  }

  private batches(
    positions: LatestPerVesselBatch<RealtimePosition>,
    safety: LatestPerVesselBatch<RealtimeSafetyState>,
    at: Date,
  ): OutgoingBatch[] {
    const time = at.toISOString();
    const out: OutgoingBatch[] = [];
    for (const [room, items] of positions.drain()) {
      if (items.length > 0 && this.isActive(room)) {
        out.push({ room, event: REALTIME_SERVER_EVENTS.POSITIONS, payload: { at: time, items } });
      }
    }
    for (const [room, items] of safety.drain()) {
      if (items.length > 0 && this.isActive(room)) {
        out.push({
          room,
          event: REALTIME_SERVER_EVENTS.SAFETY_STATES,
          payload: { at: time, items },
        });
      }
    }
    return out;
  }
}
