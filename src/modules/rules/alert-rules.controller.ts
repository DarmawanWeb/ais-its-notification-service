import { CurrentPrincipal, type Principal, RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { AlertRulesService } from './alert-rules.service.js';
import { AlertRuleDto, AlertRulePageDto } from './dto/alert-rule.dto.js';
import { ListAlertRulesQuery } from './dto/list-alert-rules.query.js';
import { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/write-alert-rule.dto.js';

/**
 * Alert rules of an organization (`/api/v2/alert-rules`, spec §13.9), all
 * routes `alert_rule:write`; rules are tenant-private (spec §8.5).
 */
@ApiTags('alert-rules')
@Controller('alert-rules')
@RequirePermissions('alert_rule:write')
export class AlertRulesController {
  constructor(private readonly rules: AlertRulesService) {}

  @Post()
  @ApiOperation({ summary: 'Create an alert rule in the active organization' })
  @ApiCreatedResponse({ type: AlertRuleDto })
  async create(
    @Body() body: CreateAlertRuleDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(await this.rules.create(body, principal, request));
  }

  @Get()
  @ApiOperation({ summary: 'List the alert rules of the organization, newest first' })
  @ApiOkResponse({ type: AlertRulePageDto })
  async list(
    @Query() query: ListAlertRulesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertRulePageDto> {
    const { page, pageSize, orgId, enabled } = query;
    return new AlertRulePageDto(
      await this.rules.list({ orgId, enabled }, { page, pageSize }, principal),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an alert rule' })
  @ApiOkResponse({ type: AlertRuleDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(await this.rules.get(id, principal));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change an alert rule' })
  @ApiOkResponse({ type: AlertRuleDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAlertRuleDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(await this.rules.update(id, body, principal, request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an alert rule and its delivery history' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.rules.remove(id, principal, request);
  }
}
