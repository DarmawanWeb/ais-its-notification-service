import { REALTIME_SERVER_EVENTS } from '@darmawanweb/ais-its-contracts/realtime';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  InjectPool,
  type Pool,
  type PoolClient,
  withIdempotency,
} from '@darmawanweb/ais-its-nest/db';
import { RetryableError } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { transactionDatabase } from '../../db/database.js';
import {
  type AlertOccurrence,
  mergeOccurrence,
} from '../../domain/alert-inbox.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { DeliveryWorker } from '../deliveries/delivery-worker.service.js';
import type { DeliveryReason } from '../deliveries/delivery.js';
import { AlertBroadcaster } from '../realtime/alert-broadcaster.js';
import { VesselsRepository } from '../vessels/vessels.repository.js';
import {
  alertRooms,
  type InboxAlert,
  newInboxAlert,
  toRealtimeAlert,
} from './alert.js';
import { AlertsRepository, type Executor } from './alerts.repository.js';
import { DeliveryPlanner } from './delivery-planner.js';

/** Durable consumer of the inbox (spec §7.3). */
export const ALERTS_CONSUMER = 'notification-alerts';

/**
 * Read–merge–write rounds of one occurrence that races with acknowledge /
 * resolve actions (each lost round means the alert's status changed).
 */
const MERGE_ATTEMPTS = 3;

/** What became of a consumed alert. */
export type IngestOutcome = 'raised' | 'merged' | 'escalated' | 'duplicate';

/** An `alert.raised.v1` envelope as consumed. */
export interface AlertEnvelope {
  readonly id: string;
  readonly source: string;
  readonly data: AlertRaisedV1;
}

interface Stored {
  readonly outcome: Exclude<IngestOutcome, 'duplicate'>;
  readonly alert: InboxAlert;
  readonly owners: readonly (string | null)[];
  readonly planned: number;
}

function occurrenceOf(alert: AlertRaisedV1): AlertOccurrence {
  return {
    severity: alert.severity,
    occurredAt: new Date(alert.occurredAt),
    title: alert.title,
    message: alert.message,
    lat: alert.lat,
    lon: alert.lon,
    relatedMmsi: alert.relatedMmsi,
    zoneId: alert.zoneId,
    methodId: alert.methodId,
    data: alert.data,
  };
}

const REASONS: Record<Stored['outcome'], DeliveryReason> = {
  raised: 'raised',
  escalated: 'escalated',
  merged: 'recurred',
};

/**
 * Stores consumed alerts in the inbox (spec §13.9). One transaction per
 * alert, idempotent by envelope id (`withIdempotency`) and serialized per
 * dedup key (advisory lock): the first occurrence of a key creates an inbox
 * alert, later occurrences while it is unresolved merge into it
 * (`mergeOccurrence`), and the matching rules' deliveries are planned in the
 * same transaction. After the commit the change is pushed to clients and the
 * delivery worker is woken.
 */
@Injectable()
export class AlertIngestService {
  private readonly logger = new Logger(AlertIngestService.name);

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly alerts: AlertsRepository,
    private readonly vessels: VesselsRepository,
    private readonly planner: DeliveryPlanner,
    private readonly worker: DeliveryWorker,
    private readonly broadcaster: AlertBroadcaster,
    private readonly metrics: NotificationMetrics,
  ) {}

  async ingest(envelope: AlertEnvelope): Promise<IngestOutcome> {
    const result = await withIdempotency(
      this.pool,
      { consumer: ALERTS_CONSUMER, eventId: envelope.id },
      (client) => this.store(client, envelope),
    );
    const stored = result.duplicate ? undefined : result.value;
    const outcome: IngestOutcome = stored?.outcome ?? 'duplicate';
    this.metrics.alertsIngested.inc({ outcome });
    if (stored !== undefined) this.afterCommit(stored);
    return outcome;
  }

  private async store(
    client: PoolClient,
    envelope: AlertEnvelope,
  ): Promise<Stored | undefined> {
    const alert = envelope.data;
    const tx = transactionDatabase(client);
    // Serializes the occurrences of one condition across consumers and instances.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`notify.alert:${alert.dedupKey}`],
    );
    const mmsis =
      alert.relatedMmsi === null
        ? [alert.mmsi]
        : [alert.mmsi, alert.relatedMmsi];
    const owners = await this.vessels.ownersOf(mmsis, tx);
    const vesselOrgId = owners.get(alert.mmsi)?.orgId ?? null;
    const relatedVesselOrgId =
      alert.relatedMmsi === null
        ? null
        : (owners.get(alert.relatedMmsi)?.orgId ?? null);

    const written = await this.write(tx, envelope, vesselOrgId);
    if (written === undefined) return undefined;
    const { alert: stored, outcome } = written;
    const planned = await this.planner.plan(
      tx,
      stored,
      {
        vesselOrgId,
        relatedVesselOrgId,
        vesselName: owners.get(alert.mmsi)?.name ?? null,
      },
      REASONS[outcome],
      new Date(),
    );
    return {
      outcome,
      alert: stored,
      owners: [vesselOrgId, relatedVesselOrgId],
      planned,
    };
  }

  /**
   * Creates the inbox alert of a new condition or merges the occurrence into
   * the unresolved one. The merge reads without row locks; when an
   * acknowledge or resolve changes the alert between the read and the
   * conditional update, the occurrence is applied again to the new state
   * (resolved: a new alert). `undefined`: the occurrence was stored before.
   *
   * @throws {RetryableError} when the alert kept changing (the consumer retries later)
   */
  private async write(
    tx: Executor,
    envelope: AlertEnvelope,
    vesselOrgId: string | null,
  ): Promise<{ alert: InboxAlert; outcome: Stored['outcome'] } | undefined> {
    const alert = envelope.data;
    for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt += 1) {
      const existing = await this.alerts.findUnresolved(tx, alert.dedupKey);
      if (existing === undefined) {
        const inserted = await this.alerts.insert(
          tx,
          newInboxAlert(alert, envelope.source, vesselOrgId),
        );
        // The occurrence was stored before (a replay after the inbox ids were pruned).
        return inserted === undefined
          ? undefined
          : { alert: inserted, outcome: 'raised' };
      }
      // The first occurrence itself, delivered again in another envelope.
      if (existing.id === alert.id) return undefined;
      const merge = mergeOccurrence(existing, occurrenceOf(alert));
      const merged = await this.alerts.updateMerged(
        tx,
        existing,
        merge.alert,
        vesselOrgId,
      );
      if (merged !== undefined) {
        return {
          alert: merged,
          outcome: merge.escalated ? 'escalated' : 'merged',
        };
      }
      this.logger.debug(
        { alertId: existing.id, dedupKey: alert.dedupKey, attempt },
        'Alert changed during a merge, merging again',
      );
    }
    throw new RetryableError(
      `Alert of ${alert.dedupKey} changed concurrently during ${MERGE_ATTEMPTS} merges`,
    );
  }

  /** Pushes the change to clients and wakes the delivery worker (best effort). */
  private afterCommit(stored: Stored): void {
    try {
      this.broadcaster.publish(
        stored.outcome === 'raised'
          ? REALTIME_SERVER_EVENTS.ALERT_RAISED
          : REALTIME_SERVER_EVENTS.ALERT_UPDATED,
        toRealtimeAlert(stored.alert),
        alertRooms(stored.owners),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, alertId: stored.alert.id },
        'Alert push failed',
      );
    }
    if (stored.planned > 0) this.worker.wake();
    this.logger.log(
      {
        alertId: stored.alert.id,
        dedupKey: stored.alert.dedupKey,
        outcome: stored.outcome,
        occurrences: stored.alert.occurrences,
        deliveries: stored.planned,
      },
      'Alert stored',
    );
  }
}
