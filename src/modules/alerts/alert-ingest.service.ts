import { REALTIME_SERVER_EVENTS } from '@darmawanweb/ais-its-contracts/realtime';
import type {
  AlertRaisedV1,
  AlertResolvedV1,
} from '@darmawanweb/ais-its-contracts/events';
import {
  InjectPool,
  type Pool,
  type PoolClient,
  withIdempotency,
} from '@darmawanweb/ais-its-nest/db';
import { RetryableError } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { transactionDatabase } from '../../db/database.js';
import type { OccurrenceOutcome } from '../../db/schema.js';
import {
  type AlertOccurrence,
  mergeOccurrence,
  resolveByDetector,
} from '../../domain/alert-inbox.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { DeliveryWorker } from '../deliveries/delivery-worker.service.js';
import type { DeliveryReason } from '../deliveries/delivery.js';
import { AlertBroadcaster } from '../realtime/alert-broadcaster.js';
import { VesselsRepository } from '../vessels/vessels.repository.js';
import {
  alertMmsis,
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
 * Read–write rounds of one occurrence or resolution that races with
 * acknowledge / resolve actions over REST (each lost round means the alert's
 * status changed).
 */
const MERGE_ATTEMPTS = 3;

/** What became of a consumed alert. */
export type IngestOutcome = 'raised' | 'merged' | 'escalated' | 'duplicate';

/**
 * What became of a consumed resolution: `resolved`; `not_found` (no
 * unresolved inbox alert with its dedup key); `later_occurrence` (the alert
 * merged an occurrence after `resolvedAt`); `duplicate` (handled before).
 * A resolution whose raise is not stored yet has no outcome: it fails with
 * a `RetryableError` until its last delivery.
 */
export type ResolutionOutcome =
  'resolved' | 'not_found' | 'later_occurrence' | 'duplicate';

/** An `alert.raised.v1` envelope as consumed. */
export interface AlertEnvelope {
  readonly id: string;
  readonly source: string;
  readonly data: AlertRaisedV1;
}

/** An `alert.resolved.v1` envelope as consumed. */
export interface ResolutionEnvelope {
  readonly id: string;
  readonly source: string;
  readonly data: AlertResolvedV1;
}

/** Where a resolution's delivery stands in the consumer's retries. */
export interface ResolutionDelivery {
  /** 1-based delivery count of the message. */
  readonly deliveryCount: number;
  /** Deliveries before the message is dead-lettered. */
  readonly maxDeliver: number;
}

interface Stored {
  readonly outcome: Exclude<IngestOutcome, 'duplicate'>;
  readonly alert: InboxAlert;
  readonly owners: readonly (string | null)[];
  readonly planned: number;
}

type StoredResolution =
  | {
      readonly outcome: 'resolved';
      readonly alert: InboxAlert;
      readonly owners: readonly (string | null)[];
    }
  | {
      readonly outcome: 'not_found' | 'later_occurrence';
      readonly alertId: string | null;
    };

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

/** Serializes the occurrences and the resolution of one condition across consumers and instances. */
async function lockDedupKey(client: PoolClient, dedupKey: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `notify.alert:${dedupKey}`,
  ]);
}

/**
 * Stores consumed alerts and resolutions in the inbox (spec §13.9, §18). One
 * transaction per event, idempotent by envelope id (`withIdempotency`) and
 * serialized per dedup key (advisory lock):
 *
 * - `alert.raised.v1`: the first occurrence of a key creates an inbox alert,
 *   later occurrences while it is unresolved merge into it
 *   (`mergeOccurrence`); every stored occurrence is recorded in the alert's
 *   history, and the matching rules' deliveries are planned in the same
 *   transaction.
 * - `alert.resolved.v1`: resolves the unresolved alert of the key unless it
 *   merged a later occurrence (`resolveByDetector`); no deliveries. A
 *   resolution can overtake its raise (a nak'd raise is redelivered after
 *   later messages of its subject; replicas handle one subject at the same
 *   time), so it waits for the raise it names (`alertId`) with retries.
 *
 * After the commit the change is pushed to clients (fan-out over every
 * instance) and the delivery worker is woken.
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

  /** Stores an `alert.raised.v1`. */
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

  /**
   * Applies an `alert.resolved.v1`: resolves the unresolved inbox alert of
   * its dedup key (`resolved_by` = `null`, `resolved_at` = `resolvedAt`, the
   * reason, the event id and data), unless there is none or it merged an
   * occurrence later than `resolvedAt`. Runs no rule deliveries; the change
   * is pushed to the current owners (as the alert is read over REST).
   *
   * Before its last delivery, a resolution whose raise (`alertId`, the
   * envelope id of the occurrence's last `alert.raised.v1`) is not stored
   * yet fails, so the raise is stored first and then resolved (also an
   * escalation that would otherwise open a new alert after the
   * resolution); on the last delivery it is applied to what is there.
   *
   * @throws {RetryableError} when the raise is not stored yet or the alert kept changing (the consumer retries later)
   */
  async resolve(
    envelope: ResolutionEnvelope,
    delivery: ResolutionDelivery,
  ): Promise<ResolutionOutcome> {
    const result = await withIdempotency(
      this.pool,
      { consumer: ALERTS_CONSUMER, eventId: envelope.id },
      (client) => this.storeResolution(client, envelope, delivery),
    );
    if (result.duplicate) {
      this.metrics.alertResolutions.inc({ outcome: 'duplicate' });
      return 'duplicate';
    }
    const stored = result.value;
    this.metrics.alertResolutions.inc({ outcome: stored.outcome });
    if (stored.outcome === 'resolved') {
      this.push(
        REALTIME_SERVER_EVENTS.ALERT_UPDATED,
        stored.alert,
        stored.owners,
      );
      this.logger.log(
        {
          alertId: stored.alert.id,
          dedupKey: stored.alert.dedupKey,
          resolutionId: envelope.id,
          resolvedAt: envelope.data.resolvedAt,
        },
        'Alert resolved by its detector',
      );
    } else {
      this.logger.debug(
        {
          dedupKey: envelope.data.dedupKey,
          resolutionId: envelope.id,
          alertId: stored.alertId,
          outcome: stored.outcome,
        },
        'Ignored an alert resolution',
      );
    }
    return stored.outcome;
  }

  private async store(
    client: PoolClient,
    envelope: AlertEnvelope,
  ): Promise<Stored | undefined> {
    const alert = envelope.data;
    const tx = transactionDatabase(client);
    await lockDedupKey(client, alert.dedupKey);
    const owners = await this.vessels.ownersOf(alertMmsis(alert), tx);
    const vesselOrgId = owners.get(alert.mmsi)?.orgId ?? null;
    const relatedVesselOrgId =
      alert.relatedMmsi === null
        ? null
        : (owners.get(alert.relatedMmsi)?.orgId ?? null);

    const written = await this.write(tx, envelope, vesselOrgId);
    if (written === undefined) return undefined;
    const { alert: stored, outcome } = written;
    await this.alerts.insertOccurrence(tx, {
      alertId: stored.id,
      alertOccurredAt: stored.occurredAt,
      eventId: envelope.id,
      occurredAt: new Date(alert.occurredAt),
      outcome: outcome satisfies OccurrenceOutcome,
      severity: alert.severity,
      relatedMmsi: alert.relatedMmsi,
      title: alert.title,
      message: alert.message,
      lat: alert.lat,
      lon: alert.lon,
      zoneId: alert.zoneId,
      methodId: alert.methodId,
      data: alert.data,
    });
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

  /**
   * Resolves the unresolved alert of the resolution's dedup key once its
   * raise is stored ({@link awaitRaise}). Like the merge it reads without
   * row locks and updates conditionally on the status it read; an
   * acknowledge in between makes it resolve the acknowledged alert, a
   * resolve over REST leaves nothing to do.
   *
   * @throws {RetryableError} when the raise is not stored yet or the alert kept changing
   */
  private async storeResolution(
    client: PoolClient,
    envelope: ResolutionEnvelope,
    delivery: ResolutionDelivery,
  ): Promise<StoredResolution> {
    const resolution = envelope.data;
    const tx = transactionDatabase(client);
    await lockDedupKey(client, resolution.dedupKey);
    const resolvedAt = new Date(resolution.resolvedAt);
    for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt += 1) {
      const existing = await this.alerts.findUnresolved(
        tx,
        resolution.dedupKey,
      );
      if (attempt === 1)
        await this.awaitRaise(tx, envelope, existing, delivery);
      if (existing === undefined)
        return { outcome: 'not_found', alertId: null };
      const decision = resolveByDetector(existing, resolvedAt);
      if (!decision.resolved) {
        return {
          outcome:
            decision.ignored === 'later_occurrence'
              ? 'later_occurrence'
              : 'not_found',
          alertId: existing.id,
        };
      }
      const resolved = await this.alerts.resolveForDetector(
        tx,
        existing,
        decision.lifecycle,
        {
          reason: resolution.reason,
          eventId: envelope.id,
          data: resolution.data,
        },
      );
      if (resolved !== undefined) {
        const owners = await this.vessels.ownersOf(alertMmsis(resolved), tx);
        return {
          outcome: 'resolved',
          alert: resolved,
          owners: [...owners.values()].map((owner) => owner.orgId),
        };
      }
      this.logger.debug(
        { alertId: existing.id, dedupKey: resolution.dedupKey, attempt },
        'Alert changed during a resolution, resolving again',
      );
    }
    throw new RetryableError(
      `Alert of ${resolution.dedupKey} changed concurrently during ${MERGE_ATTEMPTS} resolutions`,
    );
  }

  /**
   * Fails a resolution whose raise is not stored yet with a
   * `RetryableError` (nak with the consumer's backoff, about 4 minutes over
   * the default 10 deliveries), so it is applied after the raise: the raise
   * was nak'd and is redelivered after it, or another instance is storing
   * it (it holds or waits for the key's lock and has not committed). On the
   * last delivery the resolution goes ahead instead of being dead-lettered:
   * it is applied to the inbox as it is (a raise stored after that opens an
   * alert that stays open).
   */
  private async awaitRaise(
    tx: Executor,
    envelope: ResolutionEnvelope,
    unresolved: InboxAlert | undefined,
    delivery: ResolutionDelivery,
  ): Promise<void> {
    const { alertId, dedupKey } = envelope.data;
    const stored = await this.alerts.raiseStored(
      tx,
      ALERTS_CONSUMER,
      alertId,
      unresolved,
    );
    if (stored) return;
    if (delivery.deliveryCount < delivery.maxDeliver) {
      throw new RetryableError(
        `Raise ${alertId} of ${dedupKey} is not stored yet; resolution ${envelope.id} waits for it`,
      );
    }
    this.logger.warn(
      {
        alertId,
        dedupKey,
        resolutionId: envelope.id,
        deliveryCount: delivery.deliveryCount,
      },
      'Applying an alert resolution whose raise is not stored after its retries (a raise stored later stays open)',
    );
  }

  /** Pushes the change to clients and wakes the delivery worker (best effort). */
  private afterCommit(stored: Stored): void {
    this.push(
      stored.outcome === 'raised'
        ? REALTIME_SERVER_EVENTS.ALERT_RAISED
        : REALTIME_SERVER_EVENTS.ALERT_UPDATED,
      stored.alert,
      stored.owners,
    );
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

  /** Fans an alert push out to every instance (best effort). */
  private push(
    event:
      | typeof REALTIME_SERVER_EVENTS.ALERT_RAISED
      | typeof REALTIME_SERVER_EVENTS.ALERT_UPDATED,
    alert: InboxAlert,
    owners: Iterable<string | null>,
  ): void {
    try {
      this.broadcaster.publish(
        event,
        toRealtimeAlert(alert),
        alertRooms(owners),
      );
    } catch (error) {
      this.logger.warn({ err: error, alertId: alert.id }, 'Alert push failed');
    }
  }
}
