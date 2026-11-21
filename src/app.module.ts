import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import * as schema from './db/schema.js';
import { NotificationMetricsModule } from './metrics/metrics.module.js';
import { AlertsModule } from './modules/alerts/alerts.module.js';
import { DeliveriesModule } from './modules/deliveries/deliveries.module.js';
import { EmailModule } from './modules/email/email.module.js';
import { HousekeepingModule } from './modules/housekeeping/housekeeping.module.js';
import { MethodologyModule } from './modules/methodology/methodology.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RulesModule } from './modules/rules/rules.module.js';
import { VesselsModule } from './modules/vessels/vessels.module.js';

/**
 * Root module. `bootstrapService()` wraps it in the kit's platform root module
 * (configuration, logging, metrics, health, validation, problem details).
 * Nothing connects at construction time: connections, migrations and streams
 * are set up in lifecycle hooks before the HTTP port opens.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=<DATABASE_SCHEMA>,public); migrations on boot.
    DatabaseModule.forRoot({ schema }),
    // Streams this service PRODUCES to: NOTIFY (alert and test e-mails) and
    // AUDIT. The streams it consumes (ALERTS, FLEET, AIS_POSITION, SAFETY,
    // EMISSION) are only created when missing, never changed (spec §7.2).
    NatsModule.forRoot({ streams: ['NOTIFY', 'AUDIT'] }),
    // Global default-deny guard: every route needs a principal unless @Public().
    AuthModule.forRoot({ apiKeys: false }),
    AuditModule,
    NotificationMetricsModule,
    MethodologyModule,
    VesselsModule,
    RulesModule,
    DeliveriesModule,
    AlertsModule,
    EmailModule,
    RealtimeModule,
    HousekeepingModule,
  ],
})
export class AppModule {}
