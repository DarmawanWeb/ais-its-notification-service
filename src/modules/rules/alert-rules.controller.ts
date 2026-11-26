import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { IntParam, UuidParam } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import {
  CreateAlertRuleDto,
  UpdateAlertRuleDto,
} from './dto/write-alert-rule.dto.js';

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
  @ApiOperation({
    summary: 'Create an alert rule in the active organization',
    description:
      'Every webhook channel gets its own signing key: `channels[i].signingSecret` is in this response only.',
  })
  @ApiCreatedResponse({ type: AlertRuleDto })
  async create(
    @Body() body: CreateAlertRuleDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(await this.rules.create(body, principal, request));
  }

  @Get()
  @ApiOperation({
    summary: 'List the alert rules of the organization, newest first',
  })
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
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(await this.rules.view(id, principal));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change an alert rule',
    description:
      'A webhook target new to the rule gets its own signing key (`channels[i].signingSecret` in this response ' +
      'only); targets that stay keep their key; removed targets lose theirs.',
  })
  @ApiOkResponse({ type: AlertRuleDto })
  async update(
    @UuidParam() id: string,
    @Body() body: UpdateAlertRuleDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(
      await this.rules.update(id, body, principal, request),
    );
  }

  @Post(':id/channels/:index/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the signing secret of a webhook channel',
    description:
      'The channel at `index` of `channels` gets a new key: the response carries its `keyId` and, only here, ' +
      'its `signingSecret`. Deliveries from now on (pending retries included) are signed with it; receivers ' +
      'tell the keys apart by `X-AIS-ITS-Key-Id`. A webhook from before 0.2.0 gets its first own key (it was ' +
      'signed with the deployment secret). 404 RULE_CHANNEL_NOT_FOUND for an index without channel, 422 ' +
      'RULE_CHANNEL_NOT_WEBHOOK for other channel types.',
  })
  @ApiOkResponse({ type: AlertRuleDto })
  async rotateSecret(
    @UuidParam() id: string,
    @IntParam('index', { min: 0, max: 9 }) index: number,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertRuleDto> {
    return new AlertRuleDto(
      await this.rules.rotateSecret(id, index, principal, request),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an alert rule and its delivery history' })
  @ApiNoContentResponse()
  async remove(
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.rules.remove(id, principal, request);
  }
}
