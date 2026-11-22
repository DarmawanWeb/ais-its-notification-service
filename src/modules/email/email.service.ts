import type { EmailRequestedV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  NonRetryableError,
  RetryableError,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';
import * as z from 'zod';

import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { DeliveriesRepository } from '../deliveries/deliveries.repository.js';
import {
  type EmailAttempt,
  EmailLogRepository,
} from './email-log.repository.js';
import { Mailer } from './mailer.service.js';
import { EmailTemplateDataError, renderEmail } from './templates/render.js';
import type { RenderedEmail } from './templates/templates.js';

/** A consumed `notify.email.requested.v1` envelope. */
export interface EmailEnvelope {
  readonly id: string;
  readonly source: string;
  readonly data: EmailRequestedV1;
}

/** Where a delivery stands in the consumer's retries. */
export interface EmailDeliveryAttempt {
  /** 1-based delivery count of the message. */
  readonly deliveryCount: number;
  /** Deliveries before the message is dead-lettered. */
  readonly maxDeliver: number;
}

const DeliveryRefSchema = z.object({ deliveryId: z.uuid() });

/** The alert delivery an e-mail belongs to, if any. */
function deliveryIdOf(request: EmailRequestedV1): string | null {
  if (request.template !== 'alert') return null;
  return DeliveryRefSchema.safeParse(request.data).data?.deliveryId ?? null;
}

/**
 * Sends transactional e-mails (spec §13.9): renders the template in the
 * requested locale and sends it over SMTP. Idempotent by envelope id
 * (`email_log`): a redelivered request that was sent is skipped. Invalid data
 * is never retried; SMTP failures are retried by the consumer with backoff and
 * reported to the alert delivery once the last attempt failed.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly log: EmailLogRepository,
    private readonly mailer: Mailer,
    private readonly deliveries: DeliveriesRepository,
    private readonly metrics: NotificationMetrics,
  ) {}

  /**
   * @throws {NonRetryableError} for data the template refuses
   * @throws {RetryableError} when the SMTP server refused or was unreachable
   */
  async handle(
    envelope: EmailEnvelope,
    attempt: EmailDeliveryAttempt,
  ): Promise<'sent' | 'duplicate'> {
    const request = envelope.data;
    const existing = await this.log.find(envelope.id);
    if (existing !== undefined && existing.status !== 'retrying') {
      this.metrics.emails.inc({
        template: request.template,
        outcome: 'duplicate',
      });
      return 'duplicate';
    }
    const deliveryId = deliveryIdOf(request);
    const record: EmailAttempt = {
      id: envelope.id,
      toAddress: request.to,
      template: request.template,
      locale: request.locale,
      subject: null,
      source: envelope.source,
      deliveryId,
    };

    let rendered: RenderedEmail;
    try {
      rendered = renderEmail(request);
    } catch (error) {
      if (!(error instanceof EmailTemplateDataError)) throw error;
      await this.fail(record, error.message, true);
      throw new NonRetryableError(error.message, { cause: error });
    }

    const withSubject = { ...record, subject: rendered.subject };
    try {
      const sent = await this.mailer.send(request.to, rendered);
      await this.log.recordSent(withSubject, sent.messageId);
      if (deliveryId !== null)
        await this.deliveries.completeQueued(deliveryId, { sent: true });
      this.metrics.emails.inc({ template: request.template, outcome: 'sent' });
      this.logger.log(
        {
          emailId: envelope.id,
          template: request.template,
          source: envelope.source,
        },
        'E-mail sent',
      );
      return 'sent';
    } catch (error) {
      const message =
        `SMTP: ${error instanceof Error ? error.message : 'unknown error'}`.slice(
          0,
          1_000,
        );
      const final = attempt.deliveryCount >= attempt.maxDeliver;
      await this.fail(withSubject, message, final);
      throw new RetryableError(message, { cause: error });
    }
  }

  private async fail(
    record: EmailAttempt,
    error: string,
    final: boolean,
  ): Promise<void> {
    await this.log.recordFailure(record, final ? 'failed' : 'retrying', error);
    if (final && record.deliveryId !== null) {
      await this.deliveries.completeQueued(record.deliveryId, {
        sent: false,
        error,
      });
    }
    this.metrics.emails.inc({
      template: record.template,
      outcome: final ? 'failed' : 'retry',
    });
    this.logger.warn(
      { emailId: record.id, template: record.template, error, final },
      final ? 'E-mail failed for good' : 'E-mail attempt failed, retrying',
    );
  }
}
