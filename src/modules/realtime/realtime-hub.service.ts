import type {
  AisPositionRecordedV1,
  CiiUpdatedV1,
  SafetyVesselStateV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  orgRoom,
  type RealtimeAlert,
  REALTIME_SERVER_EVENTS,
  type RealtimeServerEvent,
  toRealtimePosition,
  vesselRoom,
} from '@darmawanweb/ais-its-contracts/realtime';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import {
  type OutgoingBatch,
  RealtimeBatcher,
} from '../../domain/realtime/realtime-batcher.js';
import { VesselLiveState } from '../../domain/realtime/vessel-live-state.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import type { RealtimeServer, RealtimeSocket } from './realtime.types.js';

/** Alert events pushed to clients. */
export type AlertEvent =
  | typeof REALTIME_SERVER_EVENTS.ALERT_RAISED
  | typeof REALTIME_SERVER_EVENTS.ALERT_UPDATED;

/**
 * The realtime fan-out of this instance (spec §9): keeps the latest position
 * and safety state per vessel, emits `vessel:position` / `vessel:safety` to
 * vessel rooms at once, batches `positions` / `safety:states` per tile room
 * (every `REALTIME_TILE_BATCH_INTERVAL_MS`) and for `tile:all` (every
 * `REALTIME_ALL_TILES_BATCH_INTERVAL_MS`), and emits alerts and CII updates
 * to their rooms. Rooms without a member on this instance are skipped.
 */
@Injectable()
export class RealtimeHub
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RealtimeHub.name);
  private readonly vessels: VesselLiveState;
  private readonly batcher: RealtimeBatcher;
  private readonly timers: NodeJS.Timeout[] = [];
  private server: RealtimeServer | undefined;

  constructor(
    private readonly metrics: NotificationMetrics,
    @InjectConfig() private readonly config: Config,
  ) {
    this.vessels = new VesselLiveState(config.REALTIME_MAX_VESSELS);
    this.batcher = new RealtimeBatcher((room) => this.hasMembers(room));
  }

  /** Called by the gateway once socket.io is attached to the HTTP server. */
  attach(server: RealtimeServer): void {
    this.server = server;
  }

  onApplicationBootstrap(): void {
    const tiles = setInterval(() => {
      this.emitBatches(this.batcher.flushTiles(new Date()));
    }, this.config.REALTIME_TILE_BATCH_INTERVAL_MS);
    const all = setInterval(() => {
      this.emitBatches(this.batcher.flushAll(new Date()));
    }, this.config.REALTIME_ALL_TILES_BATCH_INTERVAL_MS);
    tiles.unref();
    all.unref();
    this.timers.push(tiles, all);
  }

  /** Stops the batches and disconnects every client (they reconnect elsewhere). */
  beforeApplicationShutdown(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.server?.disconnectSockets(true);
  }

  /** A recorded position (`AIS_POSITION`). */
  onPosition(event: AisPositionRecordedV1): void {
    const update = this.vessels.applyPosition(toRealtimePosition(event));
    if (update === null) return;
    const room = vesselRoom(update.position.mmsi);
    if (this.server !== undefined && this.hasMembers(room)) {
      this.server.to(room).emit(REALTIME_SERVER_EVENTS.VESSEL_POSITION, update.position);
      this.count(REALTIME_SERVER_EVENTS.VESSEL_POSITION);
      if (update.safety !== null && update.safetyWasPending) {
        this.server.to(room).emit(REALTIME_SERVER_EVENTS.VESSEL_SAFETY, update.safety);
        this.count(REALTIME_SERVER_EVENTS.VESSEL_SAFETY);
      }
    }
    this.batcher.addPosition(update.room, update.position);
    if (update.safety !== null) {
      this.batcher.addSafetyState(update.room, update.safety);
    }
  }

  /** A vessel safety state (`SAFETY`). */
  onSafetyState(event: SafetyVesselStateV1): void {
    const update = this.vessels.applySafety(event);
    if (update === null || update.state === null || update.room === null) return;
    const room = vesselRoom(event.mmsi);
    if (this.server !== undefined && this.hasMembers(room)) {
      this.server.to(room).emit(REALTIME_SERVER_EVENTS.VESSEL_SAFETY, update.state);
      this.count(REALTIME_SERVER_EVENTS.VESSEL_SAFETY);
    }
    this.batcher.addSafetyState(update.room, update.state);
  }

  /** A CII update (`EMISSION`) for the organization owning the vessel. */
  onCiiUpdated(event: CiiUpdatedV1, orgId: string): void {
    const room = orgRoom(orgId);
    if (this.server === undefined || !this.hasMembers(room)) return;
    this.server.to(room).emit(REALTIME_SERVER_EVENTS.CII_UPDATED, event);
    this.count(REALTIME_SERVER_EVENTS.CII_UPDATED);
  }

  /** Emits an alert to the rooms of this instance (see `AlertBroadcaster`). */
  emitAlert(event: AlertEvent, alert: RealtimeAlert, rooms: readonly string[]): void {
    const active = rooms.filter((room) => this.hasMembers(room));
    if (this.server === undefined || active.length === 0) return;
    // One emit to several rooms reaches a socket that is in several rooms once.
    this.server.to(active).emit(event, alert);
    this.count(event);
  }

  /** Sends the latest known position and safety state of a vessel to one client. */
  sendSnapshot(socket: RealtimeSocket, mmsi: number): void {
    const snapshot = this.vessels.snapshot(mmsi);
    if (snapshot.position !== null) {
      socket.emit(REALTIME_SERVER_EVENTS.VESSEL_POSITION, snapshot.position);
    }
    if (snapshot.safety !== null) {
      socket.emit(REALTIME_SERVER_EVENTS.VESSEL_SAFETY, snapshot.safety);
    }
  }

  private emitBatches(batches: readonly OutgoingBatch[]): void {
    const server = this.server;
    if (server === undefined) return;
    try {
      for (const batch of batches) {
        if (batch.event === REALTIME_SERVER_EVENTS.POSITIONS) {
          server.to(batch.room).emit(batch.event, batch.payload);
        } else {
          server.to(batch.room).emit(batch.event, batch.payload);
        }
        this.count(batch.event);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Emitting realtime batches failed');
    }
  }

  private count(event: RealtimeServerEvent): void {
    this.metrics.wsMessages.inc({ event });
  }

  private hasMembers(room: string): boolean {
    return (this.server?.sockets.adapter.rooms.get(room)?.size ?? 0) > 0;
  }
}
