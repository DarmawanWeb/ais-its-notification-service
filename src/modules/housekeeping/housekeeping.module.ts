import { Module } from '@nestjs/common';

import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { EmailModule } from '../email/email.module.js';
import { HousekeepingService } from './housekeeping.service.js';

/** Retention of processed event ids, deliveries and the e-mail log. */
@Module({
  imports: [DeliveriesModule, EmailModule],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
