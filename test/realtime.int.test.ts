import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type CiiUpdatedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import {
  PositionsBatchSchema,
  REALTIME_PATH,
  RealtimeAlertSchema,
  type RealtimeClientToServerEvents,
  RealtimePositionSchema,
  RealtimeSafetyStateSchema,
  type RealtimeServerToClientEvents,
  roomsForViewport,
  SafetyStatesBatchSchema,
} from '@darmawanweb/ais-its-contracts/realtime';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  alertRaised,
  positionEvent,
  raiseAlert,
  registerVessel,
  safetyStateEvent,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

type ClientSocket = Socket<
  RealtimeServerToClientEvents,
  RealtimeClientToServerEvents
>;

/** A connected test client and every event it received. */
interface Client {
  readonly socket: ClientSocket;
  readonly events: { readonly event: string; readonly payload: unknown }[];
}

const ConnectErrorDataSchema = z.object({
  code: z.string(),
  message: z.string(),
});
const ItemsSchema = z.object({
  items: z.array(z.object({ mmsi: z.number(), time: z.string() }).loose()),
});

/** Java Sea, off Surabaya: one zoom-6 tile. */
const VIEWPORT: [number, number, number, number] = [112.5, -7.5, 113, -7];

describe('realtime gateway at /ws (spec §9)', () => {
  const orgA = newId();
  const orgB = newId();
  const sockets: ClientSocket[] = [];
  let service: TestService;

  function socketFor(token: string | undefined): ClientSocket {
    const socket: ClientSocket = io(service.url, {
      path: REALTIME_PATH,
      auth: token === undefined ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  async function connect(claims: {
    roles: Role[];
    orgId?: string | null;
    userId?: string;
  }): Promise<Client> {
    const socket = socketFor(await service.jwt.sign(claims));
    const events: Client['events'] = [];
    socket.onAny((event: string, payload: unknown) => {
      events.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { socket, events };
  }

  /** Sends an acknowledged client → server event and returns the acknowledgement. */
  async function request(
    client: Client,
    event: keyof RealtimeClientToServerEvents,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const response: unknown = await client.socket
      .timeout(5_000)
      .emitWithAck(event, payload as never);
    return response;
  }

  function received(client: Client, event: string): unknown[] {
    return client.events
      .filter((entry) => entry.event === event)
      .map((entry) => entry.payload);
  }

  /** The first `event` whose payload satisfies `match`. */
  function nextEvent(
    client: Client,
    event: string,
    match: (payload: unknown) => boolean,
  ) {
    return waitFor(() => received(client, event).find(match), {
      timeoutMs: 15_000,
    });
  }

  /** A batch (`positions` / `safety:states`) containing `mmsi` at `time`. */
  const batchWith = (mmsi: number, time?: string) => (payload: unknown) =>
    ItemsSchema.parse(payload).items.some(
      (item) =>
        item.mmsi === mmsi && (time === undefined || item.time === time),
    );

  beforeAll(async () => {
    service = await startTestService({
      listen: true,
      env: {
        // Shorter windows than the defaults (1 s / 5 s) keep the test fast.
        REALTIME_TILE_BATCH_INTERVAL_MS: '250',
        REALTIME_ALL_TILES_BATCH_INTERVAL_MS: '500',
      },
    });
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('refuses handshakes without a valid access token with UNAUTHORIZED', async () => {
    const expired = await service.jwt.sign({
      roles: ['viewer'],
      expiresInSeconds: -120,
    });
    for (const token of [undefined, 'not-a-jwt', expired]) {
      const socket = socketFor(token);
      const error = await new Promise<Error & { data?: unknown }>((resolve) => {
        socket.once('connect_error', resolve);
      });
      expect(ConnectErrorDataSchema.parse(error.data).code).toBe(
        'UNAUTHORIZED',
      );
      expect(socket.connected).toBe(false);
    }
  });

  it('accepts a valid token and validates client requests', async () => {
    const client = await connect({ roles: ['viewer'], orgId: orgA });
    expect(client.socket.connected).toBe(true);

    const invalid = await request(client, 'viewport:set', {
      bbox: [113, -7.5, 112.5, -7],
      zoom: 9,
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    const badMmsi = await request(client, 'vessel:subscribe', { mmsi: 42 });
    expect(badMmsi).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });

    const metrics = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metrics.body).toMatch(/^aisits_ws_connections [1-9]/m);
    expect(metrics.body).toMatch(
      /^aisits_ws_handshakes_total\{outcome="accepted"\} [1-9]/m,
    );
  });

  it('batches positions and safety states per viewport tile, latest per vessel', async () => {
    const client = await connect({ roles: ['viewer'], orgId: orgA });
    const ack = await request(client, 'viewport:set', {
      bbox: VIEWPORT,
      zoom: 9,
    });
    expect(ack).toEqual({
      ok: true,
      data: {
        mode: 'tiles',
        tileCount: roomsForViewport(VIEWPORT).rooms.length,
      },
    });

    const mmsi = uniqueMmsi();
    const outside = uniqueMmsi();
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 1_000);
    const { publisher } = service;
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.7, -7.2, t0),
    );
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.71, -7.21, t1),
    );
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(outside, 100.5, 2.5, t1),
    );

    const batch = PositionsBatchSchema.parse(
      await nextEvent(client, 'positions', batchWith(mmsi, t1.toISOString())),
    );
    expect(batch.items.filter((item) => item.mmsi === mmsi)).toEqual([
      expect.objectContaining({ lat: -7.21, lon: 112.71, source: 'primary' }),
    ]);

    // The safety state is pushed at the vessel's latest position.
    await publisher.publishEvent(
      EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED,
      safetyStateEvent(mmsi, new Date(t1.getTime() + 500)),
    );
    const states = SafetyStatesBatchSchema.parse(
      await nextEvent(client, 'safety:states', batchWith(mmsi)),
    );
    expect(states.items.find((item) => item.mmsi === mmsi)).toMatchObject({
      lat: -7.21,
      lon: 112.71,
      ewsStatus: 1,
      collisionRisk: 'low',
      closestEncounter: { otherMmsi: 525005999, cpaNm: 0.8, tcpaMin: 14 },
    });
    // Vessels outside the viewport tiles never reach the client.
    expect(received(client, 'positions').some(batchWith(outside))).toBe(false);
  });

  it('joins tile:all beyond 64 tiles and sends its batches', async () => {
    const client = await connect({ roles: ['viewer'], orgId: orgA });
    const ack = await request(client, 'viewport:set', {
      bbox: [80, -20, 150, 20],
      zoom: 3,
    });
    expect(ack).toEqual({ ok: true, data: { mode: 'all', tileCount: 0 } });

    const mmsi = uniqueMmsi();
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 100.5, 2.5),
    );
    PositionsBatchSchema.parse(
      await nextEvent(client, 'positions', batchWith(mmsi)),
    );
  });

  it('leaves tile:all when viewports are sent back to back (map panning)', async () => {
    const client = await connect({ roles: ['viewer'], orgId: orgA });
    // The whole world, then one tile off Surabaya, without waiting for the first ack.
    const acks = await Promise.all([
      request(client, 'viewport:set', { bbox: [-180, -85, 180, 85], zoom: 2 }),
      request(client, 'viewport:set', { bbox: VIEWPORT, zoom: 9 }),
    ]);
    expect(acks).toEqual([
      { ok: true, data: { mode: 'all', tileCount: 0 } },
      {
        ok: true,
        data: {
          mode: 'tiles',
          tileCount: roomsForViewport(VIEWPORT).rooms.length,
        },
      },
    ]);

    // A vessel in the North Sea: only tile:all would carry it.
    const northSea = uniqueMmsi();
    const inside = uniqueMmsi();
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(northSea, 3.5, 55.2),
    );
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(inside, 112.7, -7.2),
    );
    await nextEvent(client, 'positions', batchWith(inside));
    // Several tile:all windows (500 ms here) later, still nothing from tile:all.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(received(client, 'positions').some(batchWith(northSea))).toBe(false);
  });

  it('pushes vessel:position and vessel:safety to vessel rooms immediately', async () => {
    const client = await connect({ roles: ['viewer'], orgId: orgA });
    const mmsi = uniqueMmsi();
    const t0 = new Date();
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.8, -7.3, t0),
    );
    // Wait until the gateway knows the vessel (its first tile batch went out).
    const watcher = await connect({ roles: ['viewer'], orgId: orgA });
    await request(watcher, 'viewport:set', { bbox: VIEWPORT, zoom: 9 });
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.8, -7.3, new Date(t0.getTime() + 1)),
    );
    await nextEvent(watcher, 'positions', batchWith(mmsi));

    const ack = await request(client, 'vessel:subscribe', { mmsi });
    expect(ack).toEqual({ ok: true, data: { mmsi } });
    // The latest known position comes right after the acknowledgement.
    await nextEvent(
      client,
      'vessel:position',
      (payload) => RealtimePositionSchema.parse(payload).mmsi === mmsi,
    );

    const t2 = new Date(t0.getTime() + 2_000);
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.81, -7.31, t2),
    );
    const live = RealtimePositionSchema.parse(
      await nextEvent(
        client,
        'vessel:position',
        (payload) =>
          RealtimePositionSchema.parse(payload).time === t2.toISOString(),
      ),
    );
    expect(live).toMatchObject({ mmsi, lat: -7.31, lon: 112.81 });

    await service.publisher.publishEvent(
      EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED,
      safetyStateEvent(mmsi, new Date(t2.getTime() + 1), {
        ewsStatus: 0,
        collisionRisk: 'high',
      }),
    );
    const safety = RealtimeSafetyStateSchema.parse(
      await nextEvent(
        client,
        'vessel:safety',
        (payload) => RealtimeSafetyStateSchema.parse(payload).ewsStatus === 0,
      ),
    );
    expect(safety).toMatchObject({
      mmsi,
      lat: -7.31,
      lon: 112.81,
      collisionRisk: 'high',
    });
    // Vessel rooms are not tile rooms: no batches without a viewport.
    expect(received(client, 'positions')).toEqual([]);

    const left = await request(client, 'vessel:unsubscribe', { mmsi });
    expect(left).toEqual({ ok: true, data: { mmsi } });
    const t3 = new Date(t0.getTime() + 3_000);
    await service.publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      positionEvent(mmsi, 112.82, -7.32, t3),
    );
    await nextEvent(watcher, 'positions', batchWith(mmsi, t3.toISOString()));
    expect(
      received(client, 'vessel:position').some(
        (payload) =>
          RealtimePositionSchema.parse(payload).time === t3.toISOString(),
      ),
    ).toBe(false);
  });

  it('pushes alerts to the authority room and the owner organization only', async () => {
    const mmsi = uniqueMmsi();
    await registerVessel(service, { mmsi, orgId: orgA });
    const authority = await connect({ roles: ['authority'], orgId: newId() });
    const owner = await connect({ roles: ['viewer'], orgId: orgA });
    const other = await connect({ roles: ['viewer'], orgId: orgB });

    const alert = alertRaised(mmsi, { dedupKey: `ews:${mmsi}:realtime` });
    await raiseAlert(service, alert);
    const isAlert = (payload: unknown) =>
      RealtimeAlertSchema.parse(payload).id === alert.id;
    for (const client of [authority, owner]) {
      const raised = RealtimeAlertSchema.parse(
        await nextEvent(client, 'alert:raised', isAlert),
      );
      expect(raised).toMatchObject({
        status: 'open',
        occurrences: 1,
        methodId: alert.methodId,
      });
    }

    // Acknowledging over REST pushes alert:updated to the same rooms.
    const response = await service.app.inject({
      method: 'POST',
      url: `/api/v2/alerts/${alert.id}/ack`,
      headers: await service.authorization({
        roles: ['fleet_manager'],
        orgId: orgA,
      }),
    });
    expect(response.statusCode).toBe(200);
    for (const client of [authority, owner]) {
      const updated = RealtimeAlertSchema.parse(
        await nextEvent(client, 'alert:updated', isAlert),
      );
      expect(updated.status).toBe('acknowledged');
    }
    expect(received(other, 'alert:raised')).toEqual([]);
    expect(received(other, 'alert:updated')).toEqual([]);
  });

  it('pushes cii:updated to the organization of the vessel', async () => {
    const owner = await connect({ roles: ['fleet_manager'], orgId: orgA });
    const other = await connect({ roles: ['fleet_manager'], orgId: orgB });
    const update: CiiUpdatedV1 = {
      mmsi: uniqueMmsi(),
      vesselId: newId(),
      orgId: orgA,
      year: 2026,
      asOf: new Date().toISOString(),
      distanceNm: 1_250.5,
      fuelMeTon: 120.4,
      fuelAeTon: 12.1,
      co2Ton: 412.3,
      attained: 5.8,
      required: 6.1,
      rating: 0.95,
      grade: 'C',
      lastMethod: 'first_formula',
    };
    await service.publisher.publishEvent(
      EVENT_TYPES.EMISSION_CII_UPDATED,
      update,
    );

    const pushed = await nextEvent(
      owner,
      'cii:updated',
      (payload) =>
        z.object({ mmsi: z.number() }).loose().parse(payload).mmsi ===
        update.mmsi,
    );
    expect(pushed).toEqual(update);
    expect(received(other, 'cii:updated')).toEqual([]);
  });
});
