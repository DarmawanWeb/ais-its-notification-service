import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { type ConsumerEnvelope, EventHandler } from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselsRepository } from './vessels.repository.js';

/**
 * Durable consumer `notification-fleet` (spec §7.3): projects vessel
 * snapshots into `vessels`. Idempotent: a snapshot never overwrites a newer
 * one, deletions are naturally repeatable.
 */
@Injectable()
export class FleetProjection {
  private readonly logger = new Logger(FleetProjection.name);

  constructor(private readonly vessels: VesselsRepository) {}

  @EventHandler({ consumer: 'notification-fleet', concurrency: 4 })
  async onVessel(event: ConsumerEnvelope<'notification-fleet'>): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED: {
        const applied = await this.vessels.upsert(event.data);
        if (!applied) {
          this.logger.debug(
            { vesselId: event.data.id, eventId: event.id },
            'Ignored a vessel snapshot older than the stored one',
          );
        }
        break;
      }
      case EVENT_TYPES.FLEET_VESSEL_DELETED:
        await this.vessels.delete(event.data.id);
        break;
    }
  }
}
