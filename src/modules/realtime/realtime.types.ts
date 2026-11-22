import type {
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
} from '@darmawanweb/ais-its-contracts/realtime';
import type { UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';

/** Per-connection state (`socket.data`). */
export interface RealtimeSocketData {
  /** The authenticated user (handshake access token). */
  principal: UserPrincipal;
  /**
   * Tail of the connection's room changes (`viewport:set`,
   * `vessel:subscribe` / `vessel:unsubscribe`): each change starts when the
   * previous one finished, in the order the client sent them.
   */
  roomChanges: Promise<void>;
  /** Vessel rooms joined with `vessel:subscribe`. */
  vessels: Set<number>;
  /** Re-authentication timer at token expiry. */
  expiryTimer: NodeJS.Timeout | undefined;
}

/** The typed socket.io server of the gateway (spec §9). */
export type RealtimeServer = Server<
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
  DefaultEventsMap,
  RealtimeSocketData
>;

/** A typed connection of the gateway. */
export type RealtimeSocket = Socket<
  RealtimeClientToServerEvents,
  RealtimeServerToClientEvents,
  DefaultEventsMap,
  RealtimeSocketData
>;
