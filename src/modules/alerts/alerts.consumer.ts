import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { AlertIngestService } from './alert-ingest.service.js';

/**
 * Durable consumer `notification-alerts` on `ALERTS` (spec §7.3): every
 * `alert.raised.v1` of the safety and surveillance detectors goes into the
 * inbox, every `alert.resolved.v1` resolves its inbox alert. Both types come
 * through the same durable on the raise's subject `alert.v1.<type>.<mmsi>`,
 * so the raise and the resolution of an occurrence are handled in order;
 * transient failures are retried with backoff and dead-lettered by the kit
 * after `max_deliver`.
 */
@Injectable()
export class AlertsConsumer {
  constructor(private readonly ingest: AlertIngestService) {}

  @EventHandler({ consumer: 'notification-alerts', concurrency: 4 })
  async onAlert(event: ConsumerEnvelope<'notification-alerts'>): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.ALERT_RAISED:
        await this.ingest.ingest({
          id: event.id,
          source: event.source,
          data: event.data,
        });
        return;
      case EVENT_TYPES.ALERT_RESOLVED:
        await this.ingest.resolve({
          id: event.id,
          source: event.source,
          data: event.data,
        });
        return;
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled ALERTS event ${String(unreachable)}`);
      }
    }
  }
}
