import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module.js';
import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { EmailModule } from '../email/email.module.js';
import { HousekeepingService } from './housekeeping.service.js';

/** Retention of processed event ids, deliveries, the e-mail log and orphaned open-alert entries. */
@Module({
  imports: [AlertsModule, DeliveriesModule, EmailModule],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
