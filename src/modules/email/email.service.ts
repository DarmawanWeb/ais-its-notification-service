import { setTimeout as sleep } from 'node:timers/promises';

import type { EmailRequestedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import {
  NonRetryableError,
  RetryableError,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';
import * as z from 'zod';

import type { Config } from '../../config.js';
import { transactionDatabase } from '../../db/database.js';
import type { EmailStatus } from '../../db/schema.js';
import { NotificationMetrics } from '../../metrics/notification-metrics.js';
import { DeliveriesRepository } from '../deliveries/deliveries.repository.js';
import { AcceptedEmails } from './accepted-emails.js';
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

/**
 * Pauses between the attempts to record an accepted e-mail, ms; after the
 * last one the consumer redelivers the request (without sending again).
 */
export const BOOKKEEPING_RETRY_DELAYS_MS: readonly number[] = [200, 1_000];

/** Redelivery delay of a request whose accepted e-mail could not be recorded, ms. */
const BOOKKEEPING_REDELIVERY_MS = 5_000;

const DeliveryRefSchema = z.object({ deliveryId: z.uuid() });

/** The alert delivery an e-mail belongs to, if any. */
function deliveryIdOf(request: EmailRequestedV1): string | null {
  if (request.template !== 'alert') return null;
  return DeliveryRefSchema.safeParse(request.data).data?.deliveryId ?? null;
}

/** The request needs no further attempt. */
function isFinished(status: EmailStatus): boolean {
  return status === 'sent' || status === 'failed';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Sends transactional e-mails (spec §13.9): renders the template in the
 * requested locale and sends it over SMTP. Idempotent by envelope id
 * (`email_log`): a redelivered request that was sent is skipped.
 *
 * Each SMTP exchange runs under a claim of the request's `email_log` row
 * (`sending` until `claimed_until`), so two copies of one request handled at
 * the same time send it once. The SMTP exchange and the bookkeeping are
 * separate steps: once the server accepted a message it is never sent again
 * for that envelope — the log row and, for alert e-mails, the delivery are
 * recorded in one transaction, retried in place and, if the database still
 * fails, remembered in memory so the redelivered request only redoes the
 * bookkeeping. Invalid data is never retried; SMTP failures are retried by
 * the consumer with backoff and reported to the alert delivery once the last
 * attempt failed.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly accepted = new AcceptedEmails();

  /**
   * Claim of one SMTP exchange: nodemailer's connection, greeting and
   * socket timeouts plus the message transfer, ms.
   */
  private readonly claimLeaseMs: number;

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly log: EmailLogRepository,
    private readonly mailer: Mailer,
    private readonly deliveries: DeliveriesRepository,
    private readonly metrics: NotificationMetrics,
    @InjectConfig() config: Config,
  ) {
    this.claimLeaseMs = 4 * config.SMTP_TIMEOUT_MS;
  }

  /**
   * @throws {NonRetryableError} for data the template refuses
   * @throws {RetryableError} when the SMTP server refused or was unreachable,
   *   or the accepted e-mail could not be recorded (it is not sent again)
   */
  async handle(
    envelope: EmailEnvelope,
    attempt: EmailDeliveryAttempt,
  ): Promise<'sent' | 'duplicate'> {
    const request = envelope.data;
    const existing = await this.log.find(envelope.id);
    if (existing !== undefined && isFinished(existing.status)) {
      return this.duplicate(envelope);
    }
    const record: EmailAttempt = {
      id: envelope.id,
      toAddress: request.to,
      template: request.template,
      locale: request.locale,
      subject: null,
      source: envelope.source,
      deliveryId: deliveryIdOf(request),
    };

    const accepted = this.accepted.get(envelope.id);
    if (accepted !== undefined) {
      // SMTP accepted it before; only the bookkeeping failed.
      await this.recordAccepted(
        { ...record, subject: accepted.subject },
        accepted.messageId,
      );
      return this.sent(envelope);
    }

    let rendered: RenderedEmail;
    try {
      rendered = renderEmail(request);
    } catch (error) {
      if (!(error instanceof EmailTemplateDataError)) throw error;
      await this.fail(record, error.message, true);
      throw new NonRetryableError(error.message, { cause: error });
    }

    const withSubject = { ...record, subject: rendered.subject };
    const claim = await this.log.claim(withSubject, this.claimLeaseMs);
    if (!claim.claimed) {
      if (isFinished(claim.entry.status)) return this.duplicate(envelope);
      // Another copy of the request is being sent right now: wait for its outcome.
      const waitMs = (claim.entry.claimedUntil?.getTime() ?? 0) - Date.now();
      throw new RetryableError(
        `E-mail ${envelope.id} is being sent by another attempt`,
        { retryAfterMs: Math.max(1_000, waitMs) },
      );
    }
    let messageId: string;
    try {
      ({ messageId } = await this.mailer.send(request.to, rendered));
    } catch (error) {
      const message = `SMTP: ${messageOf(error)}`.slice(0, 1_000);
      const final = attempt.deliveryCount >= attempt.maxDeliver;
      await this.fail(withSubject, message, final);
      throw new RetryableError(message, { cause: error });
    }
    await this.recordAccepted(withSubject, messageId);
    return this.sent(envelope);
  }

  private duplicate(envelope: EmailEnvelope): 'duplicate' {
    this.accepted.forget(envelope.id);
    this.metrics.emails.inc({
      template: envelope.data.template,
      outcome: 'duplicate',
    });
    return 'duplicate';
  }

  private sent(envelope: EmailEnvelope): 'sent' {
    this.metrics.emails.inc({
      template: envelope.data.template,
      outcome: 'sent',
    });
    this.logger.log(
      {
        emailId: envelope.id,
        template: envelope.data.template,
        source: envelope.source,
      },
      'E-mail sent',
    );
    return 'sent';
  }

  /**
   * Records an e-mail the SMTP server accepted: the log row and the alert
   * delivery in one transaction, retried after {@link BOOKKEEPING_RETRY_DELAYS_MS}.
   * When it still fails, the acceptance is remembered and the consumer
   * redelivers the request for the bookkeeping alone.
   *
   * @throws {RetryableError} when the database kept failing
   */
  private async recordAccepted(
    record: EmailAttempt,
    messageId: string,
  ): Promise<void> {
    for (let round = 0; ; round += 1) {
      try {
        await withTransaction(this.pool, async (client) => {
          const tx = transactionDatabase(client);
          await this.log.recordSent(record, messageId, tx);
          if (record.deliveryId !== null) {
            await this.deliveries.completeQueued(
              record.deliveryId,
              { sent: true },
              tx,
            );
          }
        });
        this.accepted.forget(record.id);
        return;
      } catch (error) {
        const pause = BOOKKEEPING_RETRY_DELAYS_MS[round];
        if (pause === undefined) {
          this.accepted.remember(record.id, {
            messageId,
            subject: record.subject,
          });
          this.logger.error(
            { err: error, emailId: record.id, template: record.template },
            'E-mail sent but not recorded; the request is retried without sending again',
          );
          throw new RetryableError(
            `Recording the sent e-mail failed: ${messageOf(error)}`,
            { cause: error, retryAfterMs: BOOKKEEPING_REDELIVERY_MS },
          );
        }
        await sleep(pause);
      }
    }
  }

  /** Records a failed attempt; the last one also fails the alert delivery (one transaction). */
  private async fail(
    record: EmailAttempt,
    error: string,
    final: boolean,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const tx = transactionDatabase(client);
      await this.log.recordFailure(
        record,
        final ? 'failed' : 'retrying',
        error,
        tx,
      );
      if (final && record.deliveryId !== null) {
        await this.deliveries.completeQueued(
          record.deliveryId,
          { sent: false, error },
          tx,
        );
      }
    });
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
