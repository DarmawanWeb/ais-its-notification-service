import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { decodeQueryCursor } from '@darmawanweb/ais-its-nest/http';
import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';

import type { AlertFilter } from './alert.js';
import { AlertsService } from './alerts.service.js';
import { AlertDto, AlertPageDto, AlertSummaryDto } from './dto/alert.dto.js';
import { ListAlertsQuery } from './dto/list-alerts.query.js';

const AlertCursorSchema = z.object({
  occurredAt: z.iso.datetime(),
  id: z.uuid(),
});

/** The filter of a list query (`to` defaults to now; `from` has no default). */
function filterOf(query: ListAlertsQuery, now: Date): AlertFilter {
  const from = query.from === undefined ? undefined : new Date(query.from);
  const to = query.to === undefined ? now : new Date(query.to);
  if (from !== undefined && from > to) {
    throw new ValidationFailedError([
      {
        field: 'from',
        message: 'from must not be after to',
        code: 'timeRange',
      },
    ]);
  }
  return {
    status: query.status,
    type: query.type,
    domain: query.domain,
    severity: query.severity,
    mmsi: query.mmsi,
    from,
    to,
  };
}

/**
 * The alert inbox (`/api/v2/alerts`, spec §13.9): reads need `alert:read`,
 * acknowledging and resolving `alert:ack`. `authority` and `super_admin` see
 * every alert, other roles the alerts of their organization's vessels
 * (spec §8.5).
 */
@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @RequirePermissions('alert:read')
  @ApiOperation({ summary: 'List alerts, newest first' })
  @ApiOkResponse({ type: AlertPageDto })
  async list(
    @Query() query: ListAlertsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertPageDto> {
    const after = decodeQueryCursor(query, AlertCursorSchema);
    return new AlertPageDto(
      await this.alerts.list(
        filterOf(query, new Date()),
        after,
        query.limit,
        principal,
      ),
    );
  }

  @Get('summary')
  @RequirePermissions('alert:read')
  @ApiOperation({ summary: 'Open alert counts by severity, domain and type' })
  @ApiOkResponse({ type: AlertSummaryDto })
  async summary(
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertSummaryDto> {
    return new AlertSummaryDto(await this.alerts.summary(principal));
  }

  @Get(':id')
  @RequirePermissions('alert:read')
  @ApiOperation({ summary: 'Get an alert' })
  @ApiOkResponse({ type: AlertDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertDto> {
    return new AlertDto(await this.alerts.get(id, principal));
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('alert:ack')
  @ApiOperation({
    summary: 'Acknowledge an alert (idempotent; 409 when resolved)',
  })
  @ApiOkResponse({ type: AlertDto })
  async acknowledge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertDto> {
    return new AlertDto(await this.alerts.acknowledge(id, principal, request));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('alert:ack')
  @ApiOperation({ summary: 'Resolve an alert (idempotent)' })
  @ApiOkResponse({ type: AlertDto })
  async resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertDto> {
    return new AlertDto(await this.alerts.resolve(id, principal, request));
  }
}
