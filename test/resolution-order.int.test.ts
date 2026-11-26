import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { RetryableError } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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

const MINUTE = 60_000;

/**
 * A resolution handled before the raise it names (review of 0.2.0): the kit
 * redelivers a nak'd raise after later messages of its subject, and replicas
 * handle a raise and its resolution at the same time. The resolution waits
 * for its raise with retries instead of settling as `not_found` (the alert
 * then stayed open for good). One instance, so that the messages of a
 * subject run one after the other here.
 */
describe('resolutions handled before their raise', () => {
  const org = newId();
  let service: TestService;
  let ingest: AlertIngestService;
  let locker: pg.Client;
  let vessel: number;

  beforeAll(async () => {
    service = await startTestService();
    ingest = service.app.get(AlertIngestService);
    locker = new pg.Client({ connectionString: inject('infra').databaseUrl });
    await locker.connect();
    vessel = uniqueMmsi();
    await registerVessel(service, { mmsi: vessel, orgId: org });
  });

  afterAll(async () => {
    await locker.end();
    await service.app.close();
  });

  async function databaseNow(): Promise<Date> {
    const { rows } = await locker.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    );
    return rows[0]?.now ?? new Date();
  }

  /** Backends whose transaction (begun after `since`) waits for an alert key's advisory lock. */
  async function lockWaiters(since: Date): Promise<number[]> {
    const { rows } = await locker.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
          AND query LIKE '%pg_advisory_xact_lock%' AND xact_start > $1
        ORDER BY xact_start`,
      [since],
    );
    return rows.map((row) => row.pid);
  }

  /**
   * The review's scenario: while another session holds the key's lock, the
   * raise is published and then its resolution; the raise's waiting
   * statement fails (a transient database error, e.g. a timeout), so the kit
   * naks it with backoff and hands the resolution of the same subject to the
   * handler first; then the lock is released.
   */
  async function resolutionOvertakesRaise(
    dedupKey: string,
    publishRaise: () => Promise<void>,
    publishResolution: () => Promise<void>,
  ): Promise<void> {
    const lock = `notify.alert:${dedupKey}`;
    const started = await databaseNow();
    await locker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      lock,
    ]);
    try {
      await publishRaise();
      await publishResolution();
      // Only the raise runs: the resolution of its subject waits for it.
      const [raisePid] = await waitFor(async () => {
        const pids = await lockWaiters(started);
        return pids.length === 1 ? pids : undefined;
      });
      const cancelledAt = await databaseNow();
      await locker.query('SELECT pg_cancel_backend($1)', [raisePid]);
      // The nak'd raise waits for its backoff, the resolution runs meanwhile.
      await waitFor(async () =>
        (await lockWaiters(cancelledAt)).length === 1 ? true : undefined,
      );
    } finally {
      await locker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        lock,
      ]);
    }
  }

  async function processed(eventId: string): Promise<boolean> {
    const { rowCount } = await service.pool.query(
      `SELECT 1 FROM processed_events
        WHERE consumer = 'notification-alerts' AND event_id = $1`,
      [eventId],
    );
    return rowCount === 1;
  }

  async function alertsOf(dedupKey: string) {
    const { rows } = await service.pool.query<{
      id: string;
      status: string;
      occurrences: number;
      severity: string;
    }>(
      `SELECT id, status, occurrences, severity FROM alerts
        WHERE dedup_key = $1 ORDER BY occurred_at`,
      [dedupKey],
    );
    return rows;
  }

  it('resolves an alert whose raise was nak-ed and redelivered after its resolution', async () => {
    const raise = alertRaised(vessel, { dedupKey: `ews:${vessel}:overtaken` });
    const resolution = alertResolved(raise);
    await resolutionOvertakesRaise(
      raise.dedupKey,
      () => raiseAlert(service, raise),
      () => resolveAlert(service, resolution),
    );

    const resolved = await storedAlert(
      service,
      raise.dedupKey,
      (row) => row.status === 'resolved',
    );
    expect(resolved).toMatchObject({
      id: raise.id,
      resolvedBy: null,
      resolutionEventId: resolution.id,
    });
    expect(resolved.resolvedAt?.toISOString()).toBe(resolution.resolvedAt);
    expect(await processed(resolution.id)).toBe(true);
    expect(await alertsOf(raise.dedupKey)).toHaveLength(1);
  });

  it('merges an escalation redelivered after the resolution before resolving the alert', async () => {
    const start = Date.now() - 30 * MINUTE;
    const first = alertRaised(vessel, {
      dedupKey: `ews:${vessel}:escalation-overtaken`,
      occurredAt: new Date(start).toISOString(),
    });
    await raiseAlert(service, first);
    await storedAlert(service, first.dedupKey);
    const escalation = alertRaised(vessel, {
      dedupKey: first.dedupKey,
      severity: 'critical',
      occurredAt: new Date(start + 10 * MINUTE).toISOString(),
    });
    // The resolution names the occurrence's last raise, the escalation.
    const resolution = alertResolved(escalation, {
      openedAt: first.occurredAt,
      resolvedAt: new Date(start + 20 * MINUTE).toISOString(),
    });
    await resolutionOvertakesRaise(
      first.dedupKey,
      () => raiseAlert(service, escalation),
      () => resolveAlert(service, resolution),
    );

    await storedAlert(
      service,
      first.dedupKey,
      (row) => row.status === 'resolved',
    );
    // One alert: the escalation merged into it before the resolution (no new alert left open).
    expect(await alertsOf(first.dedupKey)).toEqual([
      {
        id: first.id,
        status: 'resolved',
        occurrences: 2,
        severity: 'critical',
      },
    ]);
    expect(await processed(escalation.id)).toBe(true);
  });

  it('lets a resolution wait for a raise another instance is storing, and applies it on its last delivery', async () => {
    // Handled before its raise committed (a replica is still storing it):
    // the resolution fails retryably and records nothing.
    const raise = alertRaised(vessel, { dedupKey: `ews:${vessel}:replica` });
    const resolution = alertResolved(raise);
    const envelope = { id: resolution.id, source: 'safety', data: resolution };
    await expect(
      ingest.resolve(envelope, { deliveryCount: 1, maxDeliver: 10 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(await processed(resolution.id)).toBe(false);
    await raiseAlert(service, raise);
    await storedAlert(service, raise.dedupKey);
    expect(
      await ingest.resolve(envelope, { deliveryCount: 2, maxDeliver: 10 }),
    ).toBe('resolved');
    expect(await storedAlert(service, raise.dedupKey)).toMatchObject({
      id: raise.id,
      status: 'resolved',
      resolutionEventId: resolution.id,
    });

    // A raise that never arrives: retried up to the last delivery, which
    // applies the resolution to the inbox as it is (no dead letter).
    const lost = alertRaised(vessel, { dedupKey: `ews:${vessel}:lost` });
    const orphan = alertResolved(lost);
    const orphanEnvelope = { id: orphan.id, source: 'safety', data: orphan };
    await expect(
      ingest.resolve(orphanEnvelope, { deliveryCount: 9, maxDeliver: 10 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(
      await ingest.resolve(orphanEnvelope, {
        deliveryCount: 10,
        maxDeliver: 10,
      }),
    ).toBe('not_found');
    expect(await processed(orphan.id)).toBe(true);

    // The last delivery of a resolution whose escalation was never stored
    // resolves the alert that is there.
    const opened = alertRaised(vessel, { dedupKey: `ews:${vessel}:partial` });
    await raiseAlert(service, opened);
    await storedAlert(service, opened.dedupKey);
    const unseen = alertRaised(vessel, {
      dedupKey: opened.dedupKey,
      severity: 'critical',
    });
    const end = alertResolved(unseen, {
      openedAt: opened.occurredAt,
      resolvedAt: new Date(Date.now() + MINUTE).toISOString(),
    });
    const endEnvelope = { id: end.id, source: 'safety', data: end };
    await expect(
      ingest.resolve(endEnvelope, { deliveryCount: 1, maxDeliver: 10 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(
      await ingest.resolve(endEnvelope, { deliveryCount: 10, maxDeliver: 10 }),
    ).toBe('resolved');
    expect(await storedAlert(service, opened.dedupKey)).toMatchObject({
      id: opened.id,
      status: 'resolved',
      resolutionEventId: end.id,
    });
  });
});
