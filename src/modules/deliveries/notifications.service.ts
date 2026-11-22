import { cursorPage } from '@darmawanweb/ais-its-nest/http';
import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  type Locale,
  newId,
  type NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import { RateLimitedError } from '@darmawanweb/ais-its-nest';
import {
  type AuditRequest,
  AuditService,
} from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { requireRuleTenancy } from '../rules/alert-rule.js';
import { ChannelPolicy } from './channels/channel-policy.js';
import type { ChannelResult } from './channels/channel-result.js';
import { EmailChannel } from './channels/email.channel.js';
import { escapeTelegramHtml } from './channels/telegram-format.js';
import { TelegramChannel } from './channels/telegram.channel.js';
import { WebhookChannel } from './channels/webhook.channel.js';
import { DeliveriesRepository } from './deliveries.repository.js';
import type { Delivery, DeliveryCursor, DeliveryFilter } from './delivery.js';
import { testText, webhookTestBody } from './notification-content.js';
import { TestThrottle } from './test-throttle.js';

/** A test notification request. */
export interface TestNotificationInput {
  readonly channel: NotificationChannel;
  readonly target: string;
  readonly locale?: Locale | undefined;
}

/** Result of a test notification. */
export interface TestNotificationResult {
  readonly channel: NotificationChannel;
  readonly target: string;
  readonly status: 'sent' | 'queued' | 'failed';
  readonly error: string | null;
}

/** Test notifications per user and instance within {@link TEST_WINDOW_MS}. */
export const TEST_LIMIT = 10;
/** Window of {@link TEST_LIMIT}, ms. */
export const TEST_WINDOW_MS = 10 * 60_000;

/** Test notifications (`POST /notifications/test`) and the delivery log. */
@Injectable()
export class NotificationsService {
  private readonly throttle = new TestThrottle(TEST_LIMIT, TEST_WINDOW_MS);

  constructor(
    private readonly policy: ChannelPolicy,
    private readonly email: EmailChannel,
    private readonly telegram: TelegramChannel,
    private readonly webhook: WebhookChannel,
    private readonly deliveries: DeliveriesRepository,
    private readonly metrics: NotificationMetrics,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sends a test notification through one channel: Telegram and webhooks
   * synchronously (`sent` / `failed`), e-mail through the e-mail pipeline
   * (`queued`).
   *
   * @throws {ValidationFailedError} for an invalid target
   * @throws {ChannelNotConfiguredError} for a channel that is not configured
   * @throws {RateLimitedError} beyond {@link TEST_LIMIT} tests per {@link TEST_WINDOW_MS}
   */
  async test(
    input: TestNotificationInput,
    principal: Principal,
    request?: AuditRequest,
  ): Promise<TestNotificationResult> {
    this.policy.assertUsable(
      [{ type: input.channel, target: input.target }],
      '',
    );
    const wait = this.throttle.take(principal.id, Date.now());
    if (wait > 0)
      throw new RateLimitedError({ retryAfterSeconds: Math.ceil(wait / 1000) });
    const locale = input.locale ?? 'id';
    const result = await this.sendTest(input, locale, principal);
    const outcome = result.outcome === 'failed' ? 'failed' : result.outcome;
    this.metrics.notificationsSent.inc({ channel: input.channel, outcome });
    await this.audit.record(
      {
        action: 'notification.test',
        targetType: 'channel',
        meta: { channel: input.channel, outcome },
      },
      principal,
      request,
    );
    return {
      channel: input.channel,
      target: input.target,
      status: outcome,
      error: result.outcome === 'failed' ? result.error : null,
    };
  }

  /** Deliveries of the principal's rules, newest first. */
  async listDeliveries(
    filter: DeliveryFilter,
    after: DeliveryCursor | undefined,
    limit: number,
    principal: Principal,
  ): Promise<CursorPage<Delivery>> {
    const rows = await this.deliveries.list(
      filter,
      requireRuleTenancy(principal),
      after,
      limit + 1,
    );
    return cursorPage(rows, limit, (row) => ({
      createdAt: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  private sendTest(
    input: TestNotificationInput,
    locale: Locale,
    principal: Principal,
  ): Promise<ChannelResult> {
    switch (input.channel) {
      case 'email':
        return this.email.queueTest(
          input.target,
          locale,
          requesterOf(principal),
        );
      case 'telegram':
        return this.telegram.send(
          input.target,
          escapeTelegramHtml(testText(locale)),
        );
      case 'webhook': {
        const id = newId();
        return this.webhook.post(
          input.target,
          webhookTestBody(id, locale, new Date()),
          id,
        );
      }
    }
  }
}

function requesterOf(principal: Principal): string {
  return principal.kind === 'user'
    ? `${principal.name} <${principal.email}>`
    : principal.id;
}
