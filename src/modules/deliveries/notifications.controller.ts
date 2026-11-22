import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { decodeQueryCursor } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';

import { DeliveryPageDto, ListDeliveriesQuery } from './dto/delivery.dto.js';
import {
  TestNotificationDto,
  TestNotificationResultDto,
} from './dto/test-notification.dto.js';
import { NotificationsService } from './notifications.service.js';

const DeliveryCursorSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

/** `/api/v2/notifications`: test notifications and the delivery log. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('alert_rule:write')
  @ApiOperation({
    summary: 'Send a test notification through one channel',
    description:
      'Telegram and webhook tests are sent at once (status sent or failed); e-mail tests are queued to the e-mail pipeline. At most 10 tests per user per 10 minutes.',
  })
  @ApiOkResponse({ type: TestNotificationResultDto })
  async test(
    @Body() body: TestNotificationDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<TestNotificationResultDto> {
    return new TestNotificationResultDto(
      await this.notifications.test(body, principal, request),
    );
  }

  @Get('deliveries')
  @RequirePermissions('alert_rule:write')
  @ApiOperation({
    summary: 'Deliveries of the alert rules of the organization, newest first',
  })
  @ApiOkResponse({ type: DeliveryPageDto })
  async deliveries(
    @Query() query: ListDeliveriesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeliveryPageDto> {
    const after = decodeQueryCursor(query, DeliveryCursorSchema);
    return new DeliveryPageDto(
      await this.notifications.listDeliveries(
        { ruleId: query.ruleId, alertId: query.alertId, status: query.status },
        after,
        query.limit,
        principal,
      ),
    );
  }
}
