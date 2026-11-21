import {
  AUTHORITY_ROOM,
  orgRoom,
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  type RealtimeAck,
  RealtimeHandshakeAuthSchema,
  userRoom,
  type ViewportSetResult,
  ViewportSetRequestSchema,
  type VesselSubscribeRequest,
  VesselSubscribeRequestSchema,
  vesselRoom,
} from '@darmawanweb/ais-its-contracts/realtime';
import { InjectConfig, ServiceUnavailableError } from '@darmawanweb/ais-its-nest';
import { AccessTokenVerifier, Public, type UserPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import * as z from 'zod';

import type { Config } from '../../config.js';
import { planViewport } from '../../domain/realtime/viewport.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { RealtimeHub } from './realtime-hub.service.js';
import type { RealtimeServer, RealtimeSocket } from './realtime.types.js';

/** `connect_error` of a refused handshake: `err.data = { code, message }` (spec §9). */
export class HandshakeError extends Error {
  readonly data: { readonly code: string; readonly message: string };

  constructor(code: 'UNAUTHORIZED' | 'SERVICE_UNAVAILABLE', message: string) {
    super(message);
    this.data = { code, message };
  }
}

const TokenExpirySchema = z.object({ exp: z.number().int().positive() });

/** `exp` of an access token that was verified already. */
export function tokenExpiry(token: string): Date | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const parsed = TokenExpirySchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? new Date(parsed.data.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Clock tolerance of the access token verifier: expiry is enforced after it, ms. */
const EXPIRY_TOLERANCE_MS = 30_000;

function invalid(message: string): RealtimeAck<never> {
  return { ok: false, error: { code: 'VALIDATION_FAILED', message } };
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`).join('; ');
}

/**
 * The realtime gateway (spec §9): socket.io on the HTTP server of the
 * service, path `/ws`. The handshake must carry an access token
 * (`auth: { token }`), verified like HTTP bearer tokens; the connection joins
 * `user:<id>`, `org:<orgId>` and, for `authority` / `super_admin`,
 * `authority`. Clients choose their tile rooms with `viewport:set` and vessel
 * rooms with `vessel:subscribe`; every request is validated with the contracts
 * schemas and acknowledged. `@Public()` only exempts the handlers from the
 * HTTP guard: authentication happens in the handshake middleware.
 */
@Public()
@WebSocketGateway({ path: REALTIME_PATH, serveClient: false })
export class RealtimeGateway
  implements OnGatewayInit<RealtimeServer>, OnGatewayConnection<RealtimeSocket>, OnGatewayDisconnect<RealtimeSocket>
{
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly verifier: AccessTokenVerifier,
    private readonly hub: RealtimeHub,
    private readonly metrics: NotificationMetrics,
    @InjectConfig() private readonly config: Config,
  ) {}

  afterInit(server: RealtimeServer): void {
    this.hub.attach(server);
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          const refusal =
            error instanceof HandshakeError
              ? error
              : new HandshakeError('UNAUTHORIZED', 'Authentication failed');
          this.metrics.wsHandshakes.inc({
            outcome: refusal.data.code === 'UNAUTHORIZED' ? 'rejected' : 'unavailable',
          });
          next(refusal);
        },
      );
    });
  }

  handleConnection(socket: RealtimeSocket): void {
    const { principal } = socket.data;
    const rooms = [userRoom(principal.id)];
    if (principal.orgId !== null) rooms.push(orgRoom(principal.orgId));
    if (principal.hasAuthorityAccess) rooms.push(AUTHORITY_ROOM);
    void socket.join(rooms);
    this.metrics.wsHandshakes.inc({ outcome: 'accepted' });
    this.metrics.wsConnections.inc();
    this.logger.debug({ socketId: socket.id, principal: principal.id }, 'Realtime client connected');
  }

  handleDisconnect(socket: RealtimeSocket): void {
    if (socket.data.expiryTimer !== undefined) clearTimeout(socket.data.expiryTimer);
    this.metrics.wsConnections.dec();
  }

  /** `viewport:set` → zoom-6 tile rooms of the box, or `tile:all` beyond 64 tiles. */
  @SubscribeMessage(REALTIME_CLIENT_EVENTS.VIEWPORT_SET)
  async onViewportSet(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck<ViewportSetResult>> {
    const request = ViewportSetRequestSchema.safeParse(body);
    if (!request.success) return invalid(issues(request.error));
    let plan;
    try {
      plan = planViewport(socket.data.viewportRooms, request.data.bbox);
    } catch (error) {
      if (error instanceof RangeError) return invalid(error.message);
      throw error;
    }
    for (const room of plan.leave) await socket.leave(room);
    if (plan.join.length > 0) await socket.join([...plan.join]);
    socket.data.viewportRooms = new Set(plan.rooms);
    return { ok: true, data: { mode: plan.mode, tileCount: plan.tileCount } };
  }

  /** `vessel:subscribe` → `vessel:<mmsi>`, then the latest known state of the vessel. */
  @SubscribeMessage(REALTIME_CLIENT_EVENTS.VESSEL_SUBSCRIBE)
  async onVesselSubscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck<VesselSubscribeRequest>> {
    const request = VesselSubscribeRequestSchema.safeParse(body);
    if (!request.success) return invalid(issues(request.error));
    const { mmsi } = request.data;
    if (
      !socket.data.vessels.has(mmsi) &&
      socket.data.vessels.size >= this.config.REALTIME_MAX_VESSEL_SUBSCRIPTIONS
    ) {
      return {
        ok: false,
        error: {
          code: 'TOO_MANY_SUBSCRIPTIONS',
          message: `At most ${this.config.REALTIME_MAX_VESSEL_SUBSCRIPTIONS} vessels per connection`,
        },
      };
    }
    await socket.join(vesselRoom(mmsi));
    socket.data.vessels.add(mmsi);
    // After the acknowledgement, so clients see the ack first.
    setImmediate(() => {
      if (socket.connected) this.hub.sendSnapshot(socket, mmsi);
    });
    return { ok: true, data: { mmsi } };
  }

  /** `vessel:unsubscribe` → leaves `vessel:<mmsi>`. */
  @SubscribeMessage(REALTIME_CLIENT_EVENTS.VESSEL_UNSUBSCRIBE)
  async onVesselUnsubscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<RealtimeAck<VesselSubscribeRequest>> {
    const request = VesselSubscribeRequestSchema.safeParse(body);
    if (!request.success) return invalid(issues(request.error));
    await socket.leave(vesselRoom(request.data.mmsi));
    socket.data.vessels.delete(request.data.mmsi);
    return { ok: true, data: { mmsi: request.data.mmsi } };
  }

  /** Verifies the handshake token and prepares `socket.data`. */
  private async authenticate(socket: RealtimeSocket): Promise<void> {
    const auth = RealtimeHandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) throw new HandshakeError('UNAUTHORIZED', 'An access token is required');
    let principal: UserPrincipal;
    try {
      principal = await this.verifier.verify(auth.data.token);
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        throw new HandshakeError('SERVICE_UNAVAILABLE', 'Signing keys are unavailable, retry later');
      }
      throw new HandshakeError('UNAUTHORIZED', 'Invalid or expired access token');
    }
    socket.data = {
      principal,
      viewportRooms: new Set(),
      vessels: new Set(),
      expiryTimer: this.reauthTimer(socket, auth.data.token),
    };
  }

  /**
   * Closes the transport when the token expires: socket.io clients then
   * reconnect on their own and present a fresh token (spec §9).
   */
  private reauthTimer(socket: RealtimeSocket, token: string): NodeJS.Timeout | undefined {
    if (!this.config.REALTIME_REAUTH_ON_TOKEN_EXPIRY) return undefined;
    const expiry = tokenExpiry(token);
    if (expiry === null) return undefined;
    // setTimeout holds at most 2^31 − 1 ms; access tokens live 15 minutes.
    const delay = Math.min(expiry.getTime() + EXPIRY_TOLERANCE_MS - Date.now(), 2_147_483_647);
    const timer = setTimeout(() => {
      this.logger.debug({ socketId: socket.id }, 'Access token expired: closing the transport');
      socket.conn.close();
    }, Math.max(0, delay));
    timer.unref();
    return timer;
  }
}
