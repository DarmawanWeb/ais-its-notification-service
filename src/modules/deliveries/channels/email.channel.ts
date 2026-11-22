import { newId } from '@darmawanweb/ais-its-contracts/domain';
import type { Locale } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import type { DeliveryPayload } from '../delivery.js';
import { type ChannelResult, failed } from './channel-result.js';

/**
 * E-mail channel: hands alert and test e-mails to the transactional e-mail
 * pipeline by publishing `notify.email.requested.v1` (stream `NOTIFY`,
 * consumer `notification-email`), which renders the `alert` / `test`
 * templates and sends them over SMTP with its own retries.
 */
@Injectable()
export class EmailChannel {
  constructor(private readonly events: EventPublisher) {}

  /**
   * Queues the alert e-mail of a delivery. The envelope id is the delivery
   * id, so a repeated attempt is deduplicated by JetStream and by the e-mail
   * log; the e-mail consumer marks the delivery `sent` or `failed`.
   */
  async queueAlert(
    deliveryId: string,
    to: string,
    payload: DeliveryPayload,
  ): Promise<ChannelResult> {
    return this.publish(
      to,
      payload.locale,
      'alert',
      {
        alert: payload.alert,
        link: payload.link,
        vesselName: payload.vesselName,
        ruleName: payload.ruleName,
        deliveryId,
      },
      deliveryId,
    );
  }

  /** Queues a test e-mail (`POST /notifications/test`). */
  async queueTest(
    to: string,
    locale: Locale,
    requestedBy: string,
  ): Promise<ChannelResult> {
    return this.publish(to, locale, 'test', { requestedBy }, newId());
  }

  private async publish(
    to: string,
    locale: Locale,
    template: 'alert' | 'test',
    data: Record<string, unknown>,
    id: string,
  ): Promise<ChannelResult> {
    try {
      await this.events.publishEvent(
        EVENT_TYPES.NOTIFY_EMAIL_REQUESTED,
        { to, template, locale, data },
        { id },
      );
      return { outcome: 'queued' };
    } catch (error) {
      return failed(
        `E-mail request could not be published: ${error instanceof Error ? error.message : 'unknown error'}`,
        false,
      );
    }
  }
}
