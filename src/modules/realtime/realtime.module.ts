import { Module } from '@nestjs/common';

import { VesselsModule } from '../vessels/vessels.module.js';
import { AlertBroadcaster } from './alert-broadcaster.js';
import { RealtimeHub } from './realtime-hub.service.js';
import { RealtimeStreams } from './realtime-streams.js';
import { RealtimeGateway } from './realtime.gateway.js';

/** The socket.io gateway at `/ws` and its NATS fan-out (spec §9). */
@Module({
  imports: [VesselsModule],
  providers: [RealtimeGateway, RealtimeHub, RealtimeStreams, AlertBroadcaster],
  exports: [AlertBroadcaster],
})
export class RealtimeModule {}
