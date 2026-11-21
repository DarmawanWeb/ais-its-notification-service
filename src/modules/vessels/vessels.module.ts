import { Module } from '@nestjs/common';

import { FleetProjection } from './fleet.projection.js';
import { VesselsRepository } from './vessels.repository.js';

/** The FLEET projection (mmsi → owner organization). */
@Module({
  providers: [VesselsRepository, FleetProjection],
  exports: [VesselsRepository],
})
export class VesselsModule {}
