import { Module } from '@nestjs/common';

import { DeliveriesModule } from '../deliveries/deliveries.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RulesModule } from '../rules/rules.module.js';
import { VesselsModule } from '../vessels/vessels.module.js';
import { AlertIngestService } from './alert-ingest.service.js';
import { AlertsConsumer } from './alerts.consumer.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsRepository } from './alerts.repository.js';
import { AlertsService } from './alerts.service.js';
import { DeliveryPlanner } from './delivery-planner.js';

/** The alert inbox: ALERTS consumer, merge, delivery planning and REST. */
@Module({
  imports: [VesselsModule, RulesModule, DeliveriesModule, RealtimeModule],
  controllers: [AlertsController],
  providers: [
    AlertsRepository,
    AlertsService,
    AlertIngestService,
    AlertsConsumer,
    DeliveryPlanner,
  ],
})
export class AlertsModule {}
