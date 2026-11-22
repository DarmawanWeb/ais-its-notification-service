import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  InjectPool,
  type Pool,
  pruneProcessedEvents,
} from '@darmawanweb/ais-its-nest/db';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import { AlertsRepository } from '../alerts/alerts.repository.js';
import { DeliveriesRepository } from '../deliveries/deliveries.repository.js';
import { DeliveryWorker } from '../deliveries/delivery-worker.service.js';
import { EmailLogRepository } from '../email/email-log.repository.js';

/** How often the retention job runs, ms. */
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;

const DAY_MS = 86_400_000;

/** Retention policy of the `alerts` hypertable (`0001_init.sql`), days. */
export const ALERTS_RETENTION_DAYS = 730;

/**
 * Retention of the service's bookkeeping tables (the `alerts` hypertable has
 * TimescaleDB policies): processed event ids after
 * `IDEMPOTENCY_RETENTION_DAYS`, finished deliveries and e-mail log rows after
 * `NOTIFICATION_LOG_RETENTION_DAYS`, and `open_alerts` entries of alerts the
 * retention policy dropped while unresolved; alert e-mails whose NOTIFY
 * request was lost are queued again (`DeliveryWorker.requeueLostEmails`).
 * Runs hourly on every instance (deletes are idempotent, e-mails are claimed
 * before sending).
 */
@Injectable()
export class HousekeepingService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(HousekeepingService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly alerts: AlertsRepository,
    private readonly deliveries: DeliveriesRepository,
    private readonly worker: DeliveryWorker,
    private readonly emails: EmailLogRepository,
    @InjectConfig() private readonly config: Config,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.running ??= this.prune().finally(() => {
        this.running = undefined;
      });
    }, HOUSEKEEPING_INTERVAL_MS);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  /** One retention pass (errors are logged, the next pass retries). */
  async prune(now: Date = new Date()): Promise<void> {
    try {
      const idsBefore = new Date(
        now.getTime() - this.config.IDEMPOTENCY_RETENTION_DAYS * DAY_MS,
      );
      const logBefore = new Date(
        now.getTime() - this.config.NOTIFICATION_LOG_RETENTION_DAYS * DAY_MS,
      );
      const alertsBefore = new Date(
        now.getTime() - ALERTS_RETENTION_DAYS * DAY_MS,
      );
      const events = await pruneProcessedEvents(this.pool, idsBefore);
      const deliveries = await this.deliveries.pruneFinished(logBefore);
      const emails = await this.emails.prune(logBefore);
      const openAlerts =
        await this.alerts.pruneOrphanedOpenAlerts(alertsBefore);
      if (events + deliveries + emails + openAlerts > 0) {
        this.logger.log(
          { events, deliveries, emails, openAlerts },
          'Pruned bookkeeping rows',
        );
      }
      await this.worker.requeueLostEmails(now);
    } catch (error) {
      this.logger.error({ err: error }, 'Retention pass failed');
    }
  }
}
