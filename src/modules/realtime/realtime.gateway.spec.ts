import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { ServiceUnavailableError } from '@darmawanweb/ais-its-nest';
import {
  type AccessTokenVerifier,
  UserPrincipal,
} from '@darmawanweb/ais-its-nest/auth';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../../config.js';
import type { NotificationMetrics } from '../../metrics/notification-metrics.js';
import type { RealtimeHub } from './realtime-hub.service.js';
import { HandshakeError, RealtimeGateway } from './realtime.gateway.js';
import type { RealtimeServer, RealtimeSocket } from './realtime.types.js';

const ORG = '0193a3c0-0000-7000-8000-00000000000a';
const USER = '0193a3c0-0000-7000-8000-0000000000aa';

function principal(roles: Role[], orgId: string | null): UserPrincipal {
  return new UserPrincipal({
    id: USER,
    sessionId: '0193a3c0-0000-7000-8000-0000000000ab',
    orgId,
    roles,
    email: 'user@example.com',
    name: 'User',
  });
}

/** Counters and gauges that only record calls. */
function fakeMetrics() {
  return {
    wsHandshakes: { inc: vi.fn() },
    wsConnections: { inc: vi.fn(), dec: vi.fn() },
  };
}

/** The gateway with a fake verifier; returns its handshake middleware. */
function gatewayWith(verify: (token: string) => Promise<UserPrincipal>) {
  const metrics = fakeMetrics();
  const gateway = new RealtimeGateway(
    { verify } as unknown as AccessTokenVerifier,
    { attach: vi.fn(), sendSnapshot: vi.fn() } as unknown as RealtimeHub,
    metrics as unknown as NotificationMetrics,
    {
      REALTIME_REAUTH_ON_TOKEN_EXPIRY: false,
      REALTIME_MAX_VESSEL_SUBSCRIPTIONS: 100,
    } as Config,
  );
  let middleware:
    | ((socket: RealtimeSocket, next: (error?: Error) => void) => void)
    | undefined;
  gateway.afterInit({
    use: (fn: typeof middleware) => {
      middleware = fn;
    },
  } as unknown as RealtimeServer);
  if (middleware === undefined) throw new Error('No middleware registered');
  const handshake = middleware;
  return {
    gateway,
    metrics,
    /** Runs the handshake middleware for `auth` and resolves with its error. */
    handshake: (auth: unknown, socket = fakeSocket(auth)) =>
      new Promise<{ error: Error | undefined; socket: RealtimeSocket }>(
        (resolve) => {
          handshake(socket, (error) => {
            resolve({ error, socket });
          });
        },
      ),
  };
}

function fakeSocket(auth: unknown, join = vi.fn()): RealtimeSocket {
  return {
    id: 'socket-1',
    handshake: { auth },
    data: {},
    join,
  } as unknown as RealtimeSocket;
}

/**
 * A connected socket whose room changes complete asynchronously (as with an
 * adapter that awaits them), recording the rooms it is in.
 */
function roomSocket(): RealtimeSocket & { rooms: Set<string> } {
  const rooms = new Set<string>(['socket-1']);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    id: 'socket-1',
    connected: true,
    rooms,
    data: {
      principal: principal(['viewer'], ORG),
      roomChanges: Promise.resolve(),
      vessels: new Set<number>(),
      expiryTimer: undefined,
    },
    join: async (joined: string | string[]) => {
      await tick();
      for (const room of [joined].flat()) rooms.add(room);
    },
    leave: async (room: string) => {
      await tick();
      rooms.delete(room);
    },
  } as unknown as RealtimeSocket & { rooms: Set<string> };
}

describe('RealtimeGateway', () => {
  it('applies viewport:set requests sent back to back in order (map panning)', async () => {
    const { gateway } = gatewayWith(() => Promise.reject(new Error('unused')));
    const socket = roomSocket();

    // The whole world (tile:all), then one tile off Surabaya, without waiting.
    const acks = await Promise.all([
      gateway.onViewportSet(socket, { bbox: [-180, -85, 180, 85], zoom: 2 }),
      gateway.onViewportSet(socket, { bbox: [112.5, -7.5, 113, -7], zoom: 9 }),
    ]);

    expect(acks).toEqual([
      { ok: true, data: { mode: 'all', tileCount: 0 } },
      { ok: true, data: { mode: 'tiles', tileCount: 1 } },
    ]);
    expect(
      [...socket.rooms].filter((room) => room.startsWith('tile:')),
    ).toEqual(['tile:6:52:33']);
  });

  it('keeps subscribe / unsubscribe of a vessel in order', async () => {
    const { gateway } = gatewayWith(() => Promise.reject(new Error('unused')));
    const socket = roomSocket();

    await Promise.all([
      gateway.onVesselSubscribe(socket, { mmsi: 525005223 }),
      gateway.onVesselUnsubscribe(socket, { mmsi: 525005223 }),
    ]);

    expect(socket.rooms.has('vessel:525005223')).toBe(false);
    expect(socket.data.vessels.size).toBe(0);
  });

  it('authenticates the handshake token and prepares the connection state', async () => {
    const user = principal(['viewer'], ORG);
    const verify = vi.fn((_token: string) => Promise.resolve(user));
    const { handshake } = gatewayWith(verify);

    const { error, socket } = await handshake({ token: 'valid-token' });

    expect(error).toBeUndefined();
    expect(verify).toHaveBeenCalledWith('valid-token');
    expect(socket.data.principal).toBe(user);
    await expect(socket.data.roomChanges).resolves.toBeUndefined();
    expect(socket.data.vessels.size).toBe(0);
  });

  it('refuses missing and invalid tokens with UNAUTHORIZED', async () => {
    const { handshake, metrics } = gatewayWith(() =>
      Promise.reject(new Error('signature verification failed')),
    );

    for (const auth of [undefined, {}, { token: '' }, { token: 'forged' }]) {
      const { error } = await handshake(auth);
      expect(error).toBeInstanceOf(HandshakeError);
      expect((error as HandshakeError).data.code).toBe('UNAUTHORIZED');
    }
    expect(metrics.wsHandshakes.inc).toHaveBeenCalledWith({
      outcome: 'rejected',
    });
  });

  it('answers SERVICE_UNAVAILABLE while the signing keys cannot be fetched', async () => {
    const { handshake } = gatewayWith(() =>
      Promise.reject(new ServiceUnavailableError('JWKS unreachable')),
    );

    const { error } = await handshake({ token: 'any' });

    expect((error as HandshakeError).data.code).toBe('SERVICE_UNAVAILABLE');
  });

  it.each([
    [['authority'], ORG, [`user:${USER}`, `org:${ORG}`, 'authority']],
    [['super_admin'], null, [`user:${USER}`, 'authority']],
    [['fleet_manager'], ORG, [`user:${USER}`, `org:${ORG}`]],
    [['viewer'], null, [`user:${USER}`]],
  ] as const)(
    'joins the personal, organization and authority rooms (%j)',
    (roles, orgId, rooms) => {
      const { gateway, metrics } = gatewayWith(() =>
        Promise.reject(new Error('unused')),
      );
      const join = vi.fn();
      const socket = fakeSocket(undefined, join);
      socket.data = {
        principal: principal([...roles], orgId),
        roomChanges: Promise.resolve(),
        vessels: new Set(),
        expiryTimer: undefined,
      };

      gateway.handleConnection(socket);

      expect(join).toHaveBeenCalledWith(rooms);
      expect(metrics.wsConnections.inc).toHaveBeenCalledTimes(1);
    },
  );
});
