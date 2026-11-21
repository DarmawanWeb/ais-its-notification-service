import type { SafetyVesselStateV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type RealtimePosition,
  type RealtimeSafetyState,
  tileRoomForPosition,
  toRealtimeSafetyState,
} from '@darmawanweb/ais-its-contracts/realtime';

/** What the gateway knows of one vessel. */
interface LiveVessel {
  position: RealtimePosition | null;
  /** Tile room of `position`. */
  room: string | null;
  /** Latest safety state (from `SAFETY`), possibly before any position. */
  safety: SafetyVesselStateV1 | null;
}

/** Result of {@link VesselLiveState.applyPosition}. */
export interface PositionUpdate {
  readonly position: RealtimePosition;
  /** Tile room of the position (`tile:6:<x>:<y>`). */
  readonly room: string;
  /**
   * The vessel's safety state at the new position when it must be pushed to
   * the room: the vessel entered another tile (clients there have not seen
   * its state) or its first position placed a state that arrived earlier.
   */
  readonly safety: RealtimeSafetyState | null;
  /** The safety state could not be placed before (no position was known). */
  readonly safetyWasPending: boolean;
}

/** Result of {@link VesselLiveState.applySafety}. */
export interface SafetyUpdate {
  /** `null` while no position of the vessel is known (the state waits for one). */
  readonly state: RealtimeSafetyState | null;
  readonly room: string | null;
}

/**
 * Latest position and safety state per vessel, in memory and bounded (least
 * recently updated vessels are evicted first). `SafetyVesselStateV1` carries
 * no coordinates, so a safety state is pushed at the latest known position of
 * its vessel; a state that arrives before any position (the `SAFETY` snapshot
 * replayed at startup) waits for the first one.
 */
export class VesselLiveState {
  private readonly vessels = new Map<number, LiveVessel>();

  /** @param maxVessels - capacity (≥ 1) */
  constructor(private readonly maxVessels: number) {
    if (!Number.isInteger(maxVessels) || maxVessels < 1) {
      throw new RangeError(`maxVessels must be a positive integer, got ${maxVessels}`);
    }
  }

  /** Number of vessels held. */
  get size(): number {
    return this.vessels.size;
  }

  /**
   * Records a position. Positions not newer than the known one (duplicates,
   * redeliveries) are ignored.
   *
   * @returns what to push, or `null` for an ignored position
   */
  applyPosition(position: RealtimePosition): PositionUpdate | null {
    const vessel = this.touch(position.mmsi);
    if (vessel.position !== null && Date.parse(position.time) <= Date.parse(vessel.position.time)) {
      return null;
    }
    const room = tileRoomForPosition(position.lon, position.lat);
    const movedToRoom = vessel.room !== room;
    const safetyWasPending = vessel.position === null && vessel.safety !== null;
    vessel.position = position;
    vessel.room = room;
    const safety =
      movedToRoom && vessel.safety !== null
        ? toRealtimeSafetyState(vessel.safety, position)
        : null;
    return { position, room, safety, safetyWasPending };
  }

  /**
   * Records a safety state. States not newer than the known one are ignored.
   *
   * @returns the state at the vessel's position, or `null` when ignored
   */
  applySafety(state: SafetyVesselStateV1): SafetyUpdate | null {
    const vessel = this.touch(state.mmsi);
    if (vessel.safety !== null && Date.parse(state.time) < Date.parse(vessel.safety.time)) {
      return null;
    }
    vessel.safety = state;
    if (vessel.position === null || vessel.room === null) {
      return { state: null, room: null };
    }
    return { state: toRealtimeSafetyState(state, vessel.position), room: vessel.room };
  }

  /** The latest position and safety state of a vessel (`vessel:subscribe`). */
  snapshot(mmsi: number): {
    readonly position: RealtimePosition | null;
    readonly safety: RealtimeSafetyState | null;
  } {
    const vessel = this.vessels.get(mmsi);
    if (vessel === undefined) return { position: null, safety: null };
    return {
      position: vessel.position,
      safety:
        vessel.position !== null && vessel.safety !== null
          ? toRealtimeSafetyState(vessel.safety, vessel.position)
          : null,
    };
  }

  /** The vessel's entry, moved to the most recently used end; evicts beyond capacity. */
  private touch(mmsi: number): LiveVessel {
    const existing = this.vessels.get(mmsi);
    if (existing !== undefined) {
      this.vessels.delete(mmsi);
      this.vessels.set(mmsi, existing);
      return existing;
    }
    const created: LiveVessel = { position: null, room: null, safety: null };
    this.vessels.set(mmsi, created);
    while (this.vessels.size > this.maxVessels) {
      const oldest = this.vessels.keys().next();
      if (oldest.done === true) break;
      this.vessels.delete(oldest.value);
    }
    return created;
  }
}
