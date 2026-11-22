import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { AlertIngestService } from './alert-ingest.service.js';

/**
 * Durable consumer `notification-alerts` on `ALERTS` (spec §7.3): every
 * `alert.raised.v1` of the safety and surveillance detectors goes into the
 * inbox. Alerts of one vessel are handled in order; transient failures are
 * retried with backoff and dead-lettered by the kit after `max_deliver`.
 */
@Injectable()
export class AlertsConsumer {
  constructor(private readonly ingest: AlertIngestService) {}

  @EventHandler({ consumer: 'notification-alerts', concurrency: 4 })
  async onAlertRaised(
    event: ConsumerEnvelope<'notification-alerts'>,
  ): Promise<void> {
    await this.ingest.ingest({
      id: event.id,
      source: event.source,
      data: event.data,
    });
  }
}
