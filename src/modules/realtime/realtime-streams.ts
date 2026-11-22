import {
  type ConsumerEnvelope,
  OrderedEventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselsRepository } from '../vessels/vessels.repository.js';
import { RealtimeHub } from './realtime-hub.service.js';

/**
 * Per-instance ordered (ephemeral) consumers of the realtime gateway (spec
 * §7.3, §13.9): every instance receives every message and pushes it to its
 * own clients. `AIS_POSITION` and `EMISSION` start with new messages;
 * `SAFETY` starts with the latest state of every vessel (`last_per_subject`)
 * to warm the state the gateway pushes at the vessels' positions.
 */
@Injectable()
export class RealtimeStreams {
  private readonly logger = new Logger(RealtimeStreams.name);

  constructor(
    private readonly hub: RealtimeHub,
    private readonly vessels: VesselsRepository,
  ) {}

  @OrderedEventHandler({ consumer: 'notification-positions', deliver: 'new' })
  onPosition(event: ConsumerEnvelope<'notification-positions'>): void {
    this.hub.onPosition(event.data);
  }

  @OrderedEventHandler({
    consumer: 'notification-safety',
    deliver: 'last_per_subject',
  })
  onSafetyState(event: ConsumerEnvelope<'notification-safety'>): void {
    this.hub.onSafetyState(event.data);
  }

  /** `cii:updated` to the owner organization (from the event, else the FLEET projection). */
  @OrderedEventHandler({ consumer: 'notification-cii', deliver: 'new' })
  async onCiiUpdated(
    event: ConsumerEnvelope<'notification-cii'>,
  ): Promise<void> {
    const orgId =
      event.data.orgId ?? (await this.vessels.orgOf(event.data.mmsi));
    if (orgId === null) {
      this.logger.debug(
        { mmsi: event.data.mmsi },
        'CII update of a vessel without organization',
      );
      return;
    }
    this.hub.onCiiUpdated(event.data, orgId);
  }
}
