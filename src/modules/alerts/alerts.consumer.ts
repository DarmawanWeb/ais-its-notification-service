import { CONSUMERS, EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  type EventContext,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { AlertIngestService } from './alert-ingest.service.js';

/**
 * Durable consumer `notification-alerts` on `ALERTS` (spec §7.3): every
 * `alert.raised.v1` of the safety and surveillance detectors goes into the
 * inbox, every `alert.resolved.v1` resolves its inbox alert. Both types come
 * through the same durable on the raise's subject `alert.v1.<type>.<mmsi>`,
 * so in the stream a resolution follows the raises of its occurrence. The
 * kit does not keep that order everywhere: a nak'd raise is redelivered
 * after its backoff, after later messages of its subject, and per-subject
 * serialization holds within one process only, so replicas may handle a
 * raise and its resolution at the same time. A resolution therefore waits,
 * with retries, until the raise it names is stored
 * (`AlertIngestService.resolve`). Transient failures are retried with
 * backoff and dead-lettered by the kit after `max_deliver`.
 */
@Injectable()
export class AlertsConsumer {
  constructor(private readonly ingest: AlertIngestService) {}

  @EventHandler({ consumer: 'notification-alerts', concurrency: 4 })
  async onAlert(
    event: ConsumerEnvelope<'notification-alerts'>,
    context: EventContext,
  ): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.ALERT_RAISED:
        await this.ingest.ingest({
          id: event.id,
          source: event.source,
          data: event.data,
        });
        return;
      case EVENT_TYPES.ALERT_RESOLVED:
        await this.ingest.resolve(
          { id: event.id, source: event.source, data: event.data },
          {
            deliveryCount: context.deliveryCount,
            maxDeliver: CONSUMERS['notification-alerts'].maxDeliver,
          },
        );
        return;
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled ALERTS event ${String(unreachable)}`);
      }
    }
  }
}
