import { CONSUMERS } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  type EventContext,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { EmailService } from './email.service.js';

/**
 * Durable consumer `notification-email` on the `NOTIFY` work queue (spec
 * §7.3): password resets and invitations from auth, alert and test e-mails
 * from this service. SMTP can be slow, hence the longer ack wait. Every
 * request has the same subject (`notify.email.v1`) and e-mails need no
 * order (idempotency comes from `email_log`), so per-subject ordering is off:
 * up to four e-mails are sent at once and one slow SMTP exchange does not
 * hold the password resets queued behind it.
 */
@Injectable()
export class EmailConsumer {
  constructor(private readonly emails: EmailService) {}

  @EventHandler({
    consumer: 'notification-email',
    concurrency: 4,
    orderBySubject: false,
    ackWaitMs: 60_000,
  })
  async onEmailRequested(
    event: ConsumerEnvelope<'notification-email'>,
    context: EventContext,
  ): Promise<void> {
    await this.emails.handle(
      { id: event.id, source: event.source, data: event.data },
      {
        deliveryCount: context.deliveryCount,
        maxDeliver: CONSUMERS['notification-email'].maxDeliver,
      },
    );
  }
}
