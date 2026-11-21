import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { InjectPool, type Pool, pruneProcessedEvents } from '@darmawanweb/ais-its-nest/db';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import { DeliveriesRepository } from '../deliveries/deliveries.repository.js';
import { EmailLogRepository } from '../email/email-log.repository.js';

/** How often the retention job runs, ms. */
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;

const DAY_MS = 86_400_000;

/**
 * Retention of the service's bookkeeping tables (the `alerts` hypertable has
 * TimescaleDB policies): processed event ids after
 * `IDEMPOTENCY_RETENTION_DAYS`, finished deliveries and e-mail log rows after
 * `NOTIFICATION_LOG_RETENTION_DAYS`. Runs hourly on every instance (deletes
 * are idempotent).
 */
@Injectable()
export class HousekeepingService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(HousekeepingService.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    @InjectPool() private readonly pool: Pool,
    private readonly deliveries: DeliveriesRepository,
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
      const idsBefore = new Date(now.getTime() - this.config.IDEMPOTENCY_RETENTION_DAYS * DAY_MS);
      const logBefore = new Date(
        now.getTime() - this.config.NOTIFICATION_LOG_RETENTION_DAYS * DAY_MS,
      );
      const events = await pruneProcessedEvents(this.pool, idsBefore);
      const deliveries = await this.deliveries.pruneFinished(logBefore);
      const emails = await this.emails.prune(logBefore);
      if (events + deliveries + emails > 0) {
        this.logger.log({ events, deliveries, emails }, 'Pruned bookkeeping rows');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Retention pass failed');
    }
  }
}
