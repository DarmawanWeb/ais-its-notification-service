import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { makeTestVesselSnapshot } from '@darmawanweb/ais-its-nest/analytics';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { VesselsRepository } from '../src/modules/vessels/vessels.repository.js';
import {
  alertRaised,
  raiseAlert,
  storedAlert,
  uniqueMmsi,
} from './support/fixtures.js';
import { startTestService, type TestService } from './support/test-service.js';

const AlertIdsSchema = z.object({ data: z.array(z.object({ id: z.uuid() })) });

interface VesselRow {
  readonly mmsi: number;
  readonly orgId: string | null;
  readonly deletedAt: Date | null;
}

describe('FLEET projection (consumer notification-fleet)', () => {
  let service: TestService;

  async function vesselRow(vesselId: string): Promise<VesselRow | undefined> {
    const { rows } = await service.pool.query<VesselRow>(
      `SELECT mmsi, org_id AS "orgId", deleted_at AS "deletedAt"
         FROM vessels WHERE vessel_id = $1`,
      [vesselId],
    );
    return rows[0];
  }

  /** Acknowledged messages of the consumer so far (`aisits_events_consumed_total`). */
  async function fleetAcks(): Promise<number> {
    const response = await service.app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const line = response.body
      .split('\n')
      .find(
        (entry) =>
          entry.startsWith('aisits_events_consumed_total{') &&
          entry.includes('consumer="notification-fleet"') &&
          entry.includes('outcome="ack"'),
      );
    return line === undefined ? 0 : Number(line.split(' ').at(-1));
  }

  async function visibleAlerts(orgId: string): Promise<string[]> {
    const response = await service.app.inject({
      method: 'GET',
      url: '/api/v2/alerts?limit=500',
      headers: await service.authorization({ roles: ['viewer'], orgId }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return AlertIdsSchema.parse(response.json()).data.map((alert) => alert.id);
  }

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('keeps a deleted vessel deleted when an older upsert is redelivered after the delete', async () => {
    const owner = newId();
    const mmsi = uniqueMmsi();
    const snapshot = makeTestVesselSnapshot({
      mmsi,
      orgId: owner,
      name: 'KM Tombstone',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await service.publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshot,
    );
    await waitFor(async () => (await vesselRow(snapshot.id)) !== undefined);
    const alert = alertRaised(mmsi, { dedupKey: `dark:${mmsi}` });
    await raiseAlert(service, alert);
    await storedAlert(service, alert.dedupKey);
    expect(await visibleAlerts(owner)).toContain(alert.id);

    await service.publisher.publishEvent(EVENT_TYPES.FLEET_VESSEL_DELETED, {
      id: snapshot.id,
      mmsi,
      orgId: owner,
    });
    const tombstone = await waitFor(async () => {
      const row = await vesselRow(snapshot.id);
      return row?.deletedAt === null ? undefined : row;
    });
    expect(tombstone).toMatchObject({ mmsi, orgId: owner });
    expect(await visibleAlerts(owner)).not.toContain(alert.id);

    // The upsert that failed transiently earlier comes back after its backoff.
    const acks = await fleetAcks();
    await service.publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshot,
      { msgId: newId() },
    );
    await waitFor(async () => (await fleetAcks()) > acks);
    expect((await vesselRow(snapshot.id))?.deletedAt).not.toBeNull();
    expect(await visibleAlerts(owner)).not.toContain(alert.id);

    // A new vessel may take the MMSI over; it owns the alerts from now on.
    const successor = newId();
    const takeover = makeTestVesselSnapshot({
      mmsi,
      orgId: successor,
      name: 'KM Successor',
      updatedAt: new Date().toISOString(),
    });
    await service.publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      takeover,
    );
    await waitFor(async () => (await vesselRow(takeover.id)) !== undefined);
    expect(await visibleAlerts(successor)).toContain(alert.id);
    expect(await visibleAlerts(owner)).not.toContain(alert.id);
  });

  it('stores a deletion that arrives before any snapshot and ignores the snapshot', async () => {
    const vessels = service.app.get(VesselsRepository);
    const mmsi = uniqueMmsi();
    const snapshot = makeTestVesselSnapshot({
      mmsi,
      orgId: newId(),
      updatedAt: new Date().toISOString(),
    });

    await vessels.markDeleted(
      { id: snapshot.id, mmsi, orgId: snapshot.orgId },
      new Date(),
    );
    await vessels.markDeleted(
      { id: snapshot.id, mmsi, orgId: snapshot.orgId },
      new Date(),
    );

    expect(await vessels.upsert(snapshot)).toBe(false);
    expect((await vesselRow(snapshot.id))?.deletedAt).not.toBeNull();
    expect((await vessels.ownersOf([mmsi])).size).toBe(0);
  });
});
