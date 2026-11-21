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
import { type Delivery, type DeliveryPayload, DeliveryPayloadSchema } from './delivery.js';
import { telegramText, webhookAlertBody } from './notification-content.js';

/**
 * Sends planned deliveries (spec §13.9: e-mail, Telegram, webhook with
 * retries). Every instance polls `deliveries` every
 * `DELIVERY_POLL_INTERVAL_MS` and when woken by a new alert; claims are
 * exclusive (`FOR UPDATE SKIP LOCKED`) and leased, so several instances share
 * the work and a crashed attempt is retried after its lease. Failures are
 * retried with exponential backoff up to `DELIVERY_MAX_ATTEMPTS`.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(DeliveryWorker.name);
  private readonly policy: RetryPolicy;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
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
    this.timer = setInterval(() => this.wake(), this.config.DELIVERY_POLL_INTERVAL_MS);
    this.timer.unref();
    this.wake();
  }

  /** Stops polling and waits for the attempts in flight. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  /** Processes due deliveries now (coalesced with a run in progress). */
  wake(): void {
    if (this.stopped) return;
    if (this.running !== undefined) {
      this.again = true;
      return;
    }
    this.running = this.drain()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Delivery run failed');
      })
      .finally(() => {
        this.running = undefined;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** Claims and attempts due deliveries until none is left. */
  private async drain(): Promise<void> {
    const size = this.config.DELIVERY_BATCH_SIZE;
    while (!this.stopped) {
      const batch = await this.deliveries.claimDue(size, this.config.DELIVERY_LEASE_MS);
      if (batch.length === 0) return;
      await Promise.all(batch.map((delivery) => this.attempt(delivery)));
      if (batch.length < size) return;
    }
  }

  /** One attempt of a claimed delivery, and its result. */
  async attempt(delivery: Delivery): Promise<void> {
    const parsed = DeliveryPayloadSchema.safeParse(delivery.payload);
    let result: ChannelResult;
    if (!parsed.success) {
      result = failed('Invalid delivery payload', true);
    } else {
      try {
        result = await this.send(delivery, parsed.data);
      } catch (error) {
        result = failed(error instanceof Error ? error.message : 'unknown error', false);
      }
    }
    if (result.outcome !== 'failed') {
      await this.deliveries.report(delivery.id, delivery.attempts, { status: result.outcome });
      this.metrics.notificationsSent.inc({ channel: delivery.channel, outcome: result.outcome });
      return;
    }
    const decision = planRetry(
      { attempt: delivery.attempts, permanent: result.permanent, retryAfterMs: result.retryAfterMs },
      this.policy,
      new Date(),
    );
    await this.deliveries.report(
      delivery.id,
      delivery.attempts,
      decision.status === 'failed'
        ? { status: 'failed', error: result.error }
        : { status: 'pending', error: result.error, nextAttemptAt: decision.nextAttemptAt },
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
        ...(decision.status === 'pending' ? { nextAttemptAt: decision.nextAttemptAt } : {}),
      },
      decision.status === 'failed' ? 'Delivery failed for good' : 'Delivery attempt failed, retrying',
    );
  }

  private send(delivery: Delivery, payload: DeliveryPayload): Promise<ChannelResult> {
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
