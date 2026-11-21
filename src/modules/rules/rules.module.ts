import { Module } from '@nestjs/common';

import { ChannelsModule } from '../deliveries/channels/channels.module.js';
import { AlertRulesController } from './alert-rules.controller.js';
import { AlertRulesRepository } from './alert-rules.repository.js';
import { AlertRulesService } from './alert-rules.service.js';

/** Alert rules (CRUD, tenancy) and their repository for rule matching. */
@Module({
  imports: [ChannelsModule],
  controllers: [AlertRulesController],
  providers: [AlertRulesRepository, AlertRulesService],
  exports: [AlertRulesRepository],
})
export class RulesModule {}
