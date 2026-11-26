import type { Role } from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  REALTIME_PATH,
  RealtimeAlertSchema,
  type RealtimeClientToServerEvents,
  type RealtimeServerToClientEvents,
} from '@darmawanweb/ais-its-contracts/realtime';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { AlertIngestService } from '../src/modules/alerts/alert-ingest.service.js';
import {
  alertRaised,
  alertResolved,
  raiseAlert,
  registerVessel,
  resolveAlert,
  storedAlert,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

type ClientSocket = Socket<
  RealtimeServerToClientEvents,
  RealtimeClientToServerEvents
>;

const AlertDtoSchema = z.object({
  id: z.uuid(),
  status: z.enum(['open', 'acknowledged', 'resolved']),
  messageKey: z.string().nullable(),
  messageParams: z.record(z.string(), z.unknown()).nullable(),
  acknowledgedBy: z.uuid().nullable(),
  resolvedBy: z.uuid().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolutionMessageKey: z.string().nullable(),
  resolutionMessageParams: z.record(z.string(), z.unknown()).nullable(),
  resolutionEventId: z.uuid().nullable(),
});

const MINUTE = 60_000;

/**
 * Resolutions announced by the detectors (`alert.resolved.v1`, contracts
 * 0.4.0) and the alert push fan-out across instances: two instances share
 * the durable consumers, socket clients are connected to both.
 */
describe('detector resolutions and the realtime fan-out (two instances)', () => {
  const org = newId();
  const sockets: ClientSocket[] = [];
  let a: TestService;
  let b: TestService;
  let vessel: number;

  async function connect(
    service: TestService,
    claims: { roles: Role[]; orgId: string },
  ) {
    const socket: ClientSocket = io(service.url, {
      path: REALTIME_PATH,
      auth: { token: await service.jwt.sign(claims) },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const events: { event: string; payload: unknown }[] = [];
    socket.onAny((event: string, payload: unknown) => {
      events.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return {
      /** The first `event` push of alert `id` with `status`. */
      push: (event: string, id: string, status: string) =>
        waitFor(
          () =>
            events
              .filter((entry) => entry.event === event)
              .map((entry) => RealtimeAlertSchema.parse(entry.payload))
              .find((alert) => alert.id === id && alert.status === status),
          { timeoutMs: 15_000 },
        ),
    };
  }

  async function alertDto(service: TestService, id: string) {
    const response = await service.app.inject({
      method: 'GET',
      url: `/api/v2/alerts/${id}`,
      headers: await service.authorization({ roles: ['authority'] }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return AlertDtoSchema.parse(response.json());
  }

  async function deliveryCount(alertId: string): Promise<number> {
    const { rows } = await a.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM deliveries WHERE alert_id = $1',
      [alertId],
    );
    return rows[0]?.count ?? 0;
  }

  beforeAll(async () => {
    a = await startTestService({ listen: true });
    b = await startTestService({ listen: true });
    vessel = uniqueMmsi();
    await registerVessel(a, { mmsi: vessel, orgId: org, name: 'KM Resolusi' });
    // A rule of the owner: raises are delivered, resolutions are not.
    const rule = await a.app.inject({
      method: 'POST',
      url: '/api/v2/alert-rules',
      headers: await a.authorization({ roles: ['fleet_manager'], orgId: org }),
      payload: {
        name: 'Everything by e-mail',
        channels: [{ type: 'email', target: `ops-${newId()}@example.com` }],
      },
    });
    expect(rule.statusCode, rule.body).toBe(201);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await a.app.close();
    await b.app.close();
  });

  it('resolves the inbox alert once from its resolution; a duplicate delivery is a no-op', async () => {
    const raise = alertRaised(vessel, {
      dedupKey: `ews:${vessel}:resolved-once`,
      data: {
        distanceM: 840,
        messageKey: 'safety.ews.anchored_near_pipeline',
        messageParams: { vessel: 'KM Resolusi (MMSI 1)', distanceM: 840 },
      },
    });
    await raiseAlert(a, raise);
    await storedAlert(a, raise.dedupKey);
    await waitFor(async () => (await deliveryCount(raise.id)) === 1);

    const resolution = alertResolved(raise, {
      reason: 'safe: not at anchor within the warning distance',
      data: { messageKey: 'safety.ews.resolved_safe', messageParams: {} },
    });
    await resolveAlert(a, resolution);
    const resolved = await storedAlert(
      a,
      raise.dedupKey,
      (row) => row.status === 'resolved',
    );
    expect(resolved).toMatchObject({
      id: raise.id,
      resolvedBy: null,
      resolutionReason: 'safe: not at anchor within the warning distance',
      resolutionEventId: resolution.id,
    });
    expect(resolved.resolvedAt?.toISOString()).toBe(resolution.resolvedAt);
    const { rowCount } = await a.pool.query(
      'SELECT 1 FROM open_alerts WHERE dedup_key = $1',
      [raise.dedupKey],
    );
    expect(rowCount).toBe(0);

    expect(await alertDto(b, raise.id)).toEqual({
      id: raise.id,
      status: 'resolved',
      messageKey: 'safety.ews.anchored_near_pipeline',
      messageParams: { vessel: 'KM Resolusi (MMSI 1)', distanceM: 840 },
      acknowledgedBy: null,
      resolvedBy: null,
      resolvedAt: resolution.resolvedAt,
      resolutionReason: 'safe: not at anchor within the warning distance',
      resolutionMessageKey: 'safety.ews.resolved_safe',
      resolutionMessageParams: {},
      resolutionEventId: resolution.id,
    });

    // The same envelope again: outside JetStream's dedup (a new message id) …
    const { rows: before } = await a.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM alerts WHERE id = $1',
      [raise.id],
    );
    await a.publisher.publishEvent(EVENT_TYPES.ALERT_RESOLVED, resolution, {
      id: resolution.id,
      msgId: newId(),
    });
    // … and handed to the consumer's service directly: idempotent by event id.
    expect(
      await b.app.get(AlertIngestService).resolve({
        id: resolution.id,
        source: 'safety',
        data: resolution,
      }),
    ).toBe('duplicate');
    const marker = alertRaised(vessel, { dedupKey: `ews:${vessel}:marker` });
    await raiseAlert(a, marker);
    await storedAlert(a, marker.dedupKey);
    const { rows: after } = await a.pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM alerts WHERE id = $1',
      [raise.id],
    );
    expect(after).toEqual(before);
    // No rule delivery for the resolution.
    expect(await deliveryCount(raise.id)).toBe(1);

    // The next occurrence of the key opens a new inbox alert.
    const again = alertRaised(vessel, { dedupKey: raise.dedupKey });
    await raiseAlert(a, again);
    expect(
      await storedAlert(a, raise.dedupKey, (row) => row.id === again.id),
    ).toMatchObject({ status: 'open', occurrences: 1 });
  });

  it('ignores a resolution older than a merged occurrence', async () => {
    const start = Date.now() - 60 * MINUTE;
    const first = alertRaised(vessel, {
      dedupKey: `ews:${vessel}:re-raised`,
      occurredAt: new Date(start).toISOString(),
    });
    await raiseAlert(a, first);
    await storedAlert(a, first.dedupKey);
    // A re-raise 20 minutes later merged before the (redelivered) resolution of 10 minutes.
    const escalation = alertRaised(vessel, {
      dedupKey: first.dedupKey,
      severity: 'critical',
      occurredAt: new Date(start + 20 * MINUTE).toISOString(),
    });
    await raiseAlert(a, escalation);
    await storedAlert(a, first.dedupKey, (row) => row.occurrences === 2);

    const ingest = a.app.get(AlertIngestService);
    const stale = alertResolved(first, {
      resolvedAt: new Date(start + 10 * MINUTE).toISOString(),
    });
    expect(
      await ingest.resolve({ id: stale.id, source: 'safety', data: stale }),
    ).toBe('later_occurrence');
    expect(await storedAlert(a, first.dedupKey)).toMatchObject({
      status: 'open',
      resolvedAt: null,
      resolutionEventId: null,
    });

    // A resolution after the latest occurrence resolves it.
    const current = alertResolved(escalation, {
      openedAt: first.occurredAt,
      resolvedAt: new Date(start + 30 * MINUTE).toISOString(),
    });
    await resolveAlert(a, current);
    expect(
      await storedAlert(a, first.dedupKey, (row) => row.status === 'resolved'),
    ).toMatchObject({ id: first.id, resolutionEventId: current.id });

    // Nothing unresolved with the key: nothing to do.
    const orphan = alertResolved(first, { dedupKey: `ews:${vessel}:never` });
    expect(
      await ingest.resolve({ id: orphan.id, source: 'safety', data: orphan }),
    ).toBe('not_found');
  });

  it('pushes the acknowledgement and the resolution to sockets on every instance', async () => {
    const onA = await connect(a, { roles: ['authority'], orgId: newId() });
    const onB = await connect(b, { roles: ['viewer'], orgId: org });
    const raise = alertRaised(vessel, { dedupKey: `ews:${vessel}:fan-out` });
    await raiseAlert(a, raise);
    for (const client of [onA, onB])
      await client.push('alert:raised', raise.id, 'open');

    // Acknowledged over REST on A: the push reaches B's clients through the fan-out.
    const ack = await a.app.inject({
      method: 'POST',
      url: `/api/v2/alerts/${raise.id}/ack`,
      headers: {
        ...(await a.authorization({ roles: ['fleet_manager'], orgId: org })),
        'content-type': 'application/json',
      },
    });
    expect(ack.statusCode, ack.body).toBe(200);
    for (const client of [onA, onB])
      await client.push('alert:updated', raise.id, 'acknowledged');

    // Resolved by its detector (consumed by either instance): every client sees it.
    await resolveAlert(a, alertResolved(raise));
    for (const client of [onA, onB]) {
      const pushed = await client.push('alert:updated', raise.id, 'resolved');
      expect(pushed).toMatchObject({ occurrences: 1, data: raise.data });
    }
    expect(await alertDto(a, raise.id)).toMatchObject({
      status: 'resolved',
      acknowledgedBy: expect.any(String) as string,
      resolvedBy: null,
    });
  });
});
