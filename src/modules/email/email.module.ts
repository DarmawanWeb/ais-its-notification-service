import { Module } from '@nestjs/common';

import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { EmailLogRepository } from './email-log.repository.js';
import { EmailConsumer } from './email.consumer.js';
import { EmailService } from './email.service.js';
import { Mailer } from './mailer.service.js';

/** Transactional e-mail: the NOTIFY consumer, templates and SMTP. */
@Module({
  imports: [DeliveriesModule],
  providers: [EmailLogRepository, EmailService, EmailConsumer, Mailer],
  exports: [EmailLogRepository],
})
export class EmailModule {}
