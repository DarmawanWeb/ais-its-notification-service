import { STREAMS } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import { planRetry, type RetryPolicy } from '../../domain/delivery-retry.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { type ChannelResult, failed } from './channels/channel-result.js';
import { EmailChannel } from './channels/email.channel.js';
import { TelegramChannel } from './channels/telegram.channel.js';
import { WebhookChannel } from './channels/webhook.channel.js';
import { DeliveriesRepository } from './deliveries.repository.js';
import {
  type Delivery,
  type DeliveryPayload,
  DeliveryPayloadSchema,
} from './delivery.js';
import { telegramText, webhookAlertBody } from './notification-content.js';

/** A queued alert e-mail without progress for this long is queued again, ms. */
export const EMAIL_REQUEUE_AFTER_MS = 60 * 60_000;

/** Lost e-mails handled per housekeeping pass. */
const REQUEUE_BATCH_SIZE = 500;

/**
 * Sends planned deliveries (spec §13.9: e-mail, Telegram, webhook with
 * retries). Every instance polls `deliveries` every
 * `DELIVERY_POLL_INTERVAL_MS` and when woken by a new alert; claims are
 * exclusive (`FOR UPDATE SKIP LOCKED`) and leased, so several instances share
 * the work and a crashed attempt is retried after its lease. Attempts run in
 * a pool of `DELIVERY_CONCURRENCY` slots that is refilled as soon as a slot
 * frees up: a slow receiver holds its own slot (bounded by its channel
 * timeout), never the deliveries of other rules or tenants. Failures are
 * retried with exponential backoff up to `DELIVERY_MAX_ATTEMPTS`.
 */
@Injectable()
export class DeliveryWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(DeliveryWorker.name);
  private readonly policy: RetryPolicy;
  /** Attempts in flight. */
  private readonly inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  /** The claim loop in progress, if any. */
  private claiming: Promise<void> | undefined;
  /** Woken while the claim loop ran: claim again when it ends. */
  private again = false;
  /** The last claim loop stopped because every slot was busy. */
  private saturated = false;
  private stopped = false;

  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly email: EmailChannel,
    private readonly telegram: TelegramChannel,
    private readonly webhook: WebhookChannel,
    private readonly metrics: NotificationMetrics,
    @InjectConfig() private readonly config: Config,
  ) {
    this.policy = {
      maxAttempts: config.DELIVERY_MAX_ATTEMPTS,
      baseDelayMs: config.DELIVERY_RETRY_BASE_MS,
      maxDelayMs: config.DELIVERY_RETRY_MAX_MS,
    };
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.wake();
    }, this.config.DELIVERY_POLL_INTERVAL_MS);
    this.timer.unref();
    this.wake();
  }

  /** Stops claiming and waits for the attempts in flight. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.claiming;
    await Promise.all([...this.inFlight]);
  }

  /** Claims due deliveries into free slots now (coalesced with a claim in progress). */
  wake(): void {
    if (this.stopped) return;
    if (this.claiming !== undefined) {
      this.again = true;
      return;
    }
    this.claiming = this.fill()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Claiming deliveries failed');
      })
      .finally(() => {
        this.claiming = undefined;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** Claims due deliveries until none is due or every slot is busy. */
  private async fill(): Promise<void> {
    this.saturated = false;
    while (!this.stopped) {
      const free = this.config.DELIVERY_CONCURRENCY - this.inFlight.size;
      if (free <= 0) {
        // A finishing attempt wakes the loop again.
        this.saturated = true;
        return;
      }
      const claimed = await this.deliveries.claimDue(
        free,
        this.config.DELIVERY_LEASE_MS,
      );
      for (const delivery of claimed) this.start(delivery);
      if (claimed.length < free) return;
    }
  }

  /** Runs one attempt in a slot; a freed slot of a saturated pool is refilled at once. */
  private start(delivery: Delivery): void {
    const task: Promise<void> = this.attempt(delivery)
      .catch((error: unknown) => {
        // The result could not be stored: the lease expires and the delivery is claimed again.
        this.logger.error(
          { err: error, deliveryId: delivery.id },
          'Delivery attempt failed to complete',
        );
      })
      .finally(() => {
        this.inFlight.delete(task);
        if (this.saturated) this.wake();
      });
    this.inFlight.add(task);
  }

  /**
   * Queues again the alert e-mails whose NOTIFY request was lost (e.g. a
   * purged stream): `queued` for over {@link EMAIL_REQUEUE_AFTER_MS} without
   * a final or recent `email_log` row. The envelope id is the delivery id
   * and the e-mail consumer claims each request before sending, so an
   * e-mail is sent once however often it is queued. A delivery older than
   * the NOTIFY max age (7 days) is failed instead.
   *
   * @returns the e-mails queued again and the deliveries given up
   */
  async requeueLostEmails(
    now: Date = new Date(),
  ): Promise<{ requeued: number; expired: number }> {
    const lost = await this.deliveries.lostQueuedEmails(
      new Date(now.getTime() - EMAIL_REQUEUE_AFTER_MS),
      REQUEUE_BATCH_SIZE,
    );
    let requeued = 0;
    let expired = 0;
    for (const delivery of lost) {
      const parsed = DeliveryPayloadSchema.safeParse(delivery.payload);
      if (
        !parsed.success ||
        now.getTime() - delivery.createdAt.getTime() > STREAMS.NOTIFY.maxAgeMs
      ) {
        await this.deliveries.completeQueued(delivery.id, {
          sent: false,
          error: 'The e-mail request was lost and is no longer queued again',
        });
        expired += 1;
        continue;
      }
      const result = await this.email.queueAlert(
        delivery.id,
        delivery.target,
        parsed.data,
      );
      if (result.outcome === 'queued') {
        await this.deliveries.touchQueued(delivery.id);
        requeued += 1;
      }
    }
    if (requeued + expired > 0) {
      this.logger.warn(
        { requeued, expired },
        'Queued lost alert e-mails again',
      );
    }
    return { requeued, expired };
  }

  /** One attempt of a claimed delivery, and its result. */
  private async attempt(delivery: Delivery): Promise<void> {
    const parsed = DeliveryPayloadSchema.safeParse(delivery.payload);
    let result: ChannelResult;
    if (!parsed.success) {
      result = failed('Invalid delivery payload', true);
    } else {
      try {
        result = await this.send(delivery, parsed.data);
      } catch (error) {
        result = failed(
          error instanceof Error ? error.message : 'unknown error',
          false,
        );
      }
    }
    if (result.outcome !== 'failed') {
      await this.deliveries.report(delivery.id, delivery.attempts, {
        status: result.outcome,
      });
      this.metrics.notificationsSent.inc({
        channel: delivery.channel,
        outcome: result.outcome,
      });
      return;
    }
    const decision = planRetry(
      {
        attempt: delivery.attempts,
        permanent: result.permanent,
        retryAfterMs: result.retryAfterMs,
      },
      this.policy,
      new Date(),
    );
    await this.deliveries.report(
      delivery.id,
      delivery.attempts,
      decision.status === 'failed'
        ? { status: 'failed', error: result.error }
        : {
            status: 'pending',
            error: result.error,
            nextAttemptAt: decision.nextAttemptAt,
          },
    );
    this.metrics.notificationsSent.inc({
      channel: delivery.channel,
      outcome: decision.status === 'failed' ? 'failed' : 'retry',
    });
    this.logger.warn(
      {
        deliveryId: delivery.id,
        alertId: delivery.alertId,
        channel: delivery.channel,
        attempt: delivery.attempts,
        error: result.error,
        ...(decision.status === 'pending'
          ? { nextAttemptAt: decision.nextAttemptAt }
          : {}),
      },
      decision.status === 'failed'
        ? 'Delivery failed for good'
        : 'Delivery attempt failed, retrying',
    );
  }

  private send(
    delivery: Delivery,
    payload: DeliveryPayload,
  ): Promise<ChannelResult> {
    switch (delivery.channel) {
      case 'email':
        return this.email.queueAlert(delivery.id, delivery.target, payload);
      case 'telegram':
        return this.telegram.send(delivery.target, telegramText(payload));
      case 'webhook':
        return this.webhook.post(
          delivery.target,
          webhookAlertBody(delivery, payload, new Date()),
          delivery.id,
        );
    }
  }
}
