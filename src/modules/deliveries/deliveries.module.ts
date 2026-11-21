import { Module } from '@nestjs/common';

import { ChannelsModule } from './channels/channels.module.js';
import { DeliveriesRepository } from './deliveries.repository.js';
import { DeliveryWorker } from './delivery-worker.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/** Alert deliveries (worker with retries), test notifications and the delivery log. */
@Module({
  imports: [ChannelsModule],
  controllers: [NotificationsController],
  providers: [DeliveriesRepository, DeliveryWorker, NotificationsService],
  exports: [DeliveriesRepository, DeliveryWorker],
})
export class DeliveriesModule {}
