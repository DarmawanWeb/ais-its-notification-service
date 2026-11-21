import { Global, Module } from '@nestjs/common';

import { NotificationMetrics } from './notification-metrics.js';

/** The service's domain metrics, available to every feature module. */
@Global()
@Module({ providers: [NotificationMetrics], exports: [NotificationMetrics] })
export class NotificationMetricsModule {}
