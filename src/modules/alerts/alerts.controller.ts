import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { decodeQueryCursor, UuidParam } from '@darmawanweb/ais-its-nest/http';
import { InjectConfig, ValidationFailedError } from '@darmawanweb/ais-its-nest';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import * as z from 'zod';

import type { Config } from '../../config.js';
import { addVary, preferredLocale } from '../../domain/csv.js';
import type { AlertFilter } from './alert.js';
import { AlertsService } from './alerts.service.js';
import { AlertDto, AlertPageDto, AlertSummaryDto } from './dto/alert.dto.js';
import { AlertSeriesDto, AlertSeriesQuery } from './dto/alert-series.dto.js';
import {
  type AlertFilterQuery,
  ExportAlertsQuery,
  ListAlertsQuery,
} from './dto/list-alerts.query.js';
import {
  AlertOccurrencePageDto,
  ListOccurrencesQuery,
} from './dto/occurrence.dto.js';
import { MarkAlertsReadDto, UnreadCountDto } from './dto/read-state.dto.js';

/** Response header telling that a CSV export was cut at `ALERT_EXPORT_MAX_ROWS`. */
export const TRUNCATED_HEADER = 'X-Truncated';

const AlertCursorSchema = z.object({
  occurredAt: z.iso.datetime(),
  id: z.uuid(),
});

/**
 * Body of `POST /alerts/read`, validated here: a bodiless request (also with
 * `Content-Type: application/json`, kit 0.3) marks everything read, which a
 * DTO-typed `@Body()` would refuse.
 */
const MarkReadBodySchema = z
  .object({ upTo: z.iso.datetime({ offset: true }).optional() })
  .strict()
  .optional();

const OccurrenceCursorSchema = z.object({
  occurredAt: z.iso.datetime(),
  eventId: z.uuid(),
});

/** The filter fields of `GET /alerts`, `/alerts/export.csv` and `/alerts/stats/series`. */
type AlertFilterFields = Pick<
  AlertFilterQuery,
  'status' | 'type' | 'domain' | 'severity' | 'mmsi' | 'from' | 'to'
>;

/** The filter of a list query (`to` defaults to now; `from` has no default). */
function filterOf(query: AlertFilterFields, now: Date): AlertFilter {
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
  constructor(
    private readonly alerts: AlertsService,
    @InjectConfig() private readonly config: Config,
  ) {}

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

  @Get('unread-count')
  @RequirePermissions('alert:read')
  @ApiOperation({
    summary: 'Unread open alerts of the user in the active organization',
    description:
      'Open alerts visible to the user stored or changed (`updatedAt`) after the read mark of POST /alerts/read; ' +
      'every open alert before the first mark. The mark is per user and active organization.',
  })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(
    @CurrentPrincipal() principal: Principal,
  ): Promise<UnreadCountDto> {
    const { unread, readUpTo } = await this.alerts.unread(principal);
    return new UnreadCountDto(unread, readUpTo);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('alert:read')
  @ApiOperation({
    summary: 'Mark the alerts read up to a time',
    description:
      'Moves the read mark of the user in the active organization forward to `upTo` (default and maximum: now; ' +
      'it never moves backwards) and answers the new unread count. Bodiless requests mark everything read.',
  })
  @ApiBody({ type: MarkAlertsReadDto, required: false })
  @ApiOkResponse({ type: UnreadCountDto })
  async markRead(
    @Body() raw: unknown,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UnreadCountDto> {
    const body = MarkReadBodySchema.safeParse(raw);
    if (!body.success) {
      throw new ValidationFailedError(
        body.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys'
            ? issue.keys.map((key) => ({
                field: key,
                message: `property ${key} should not exist`,
                code: 'whitelistValidation',
              }))
            : [
                {
                  field: issue.path.join('.') || 'body',
                  message:
                    issue.path[0] === 'upTo'
                      ? 'upTo must be an ISO-8601 date-time'
                      : 'The body must be an object',
                  code: issue.path[0] === 'upTo' ? 'isIso8601' : 'isObject',
                },
              ],
        ),
      );
    }
    const upTo =
      body.data?.upTo === undefined ? undefined : new Date(body.data.upTo);
    const { unread, readUpTo } = await this.alerts.markRead(upTo, principal);
    return new UnreadCountDto(unread, readUpTo);
  }

  @Get('stats/series')
  @RequirePermissions('alert:read')
  @ApiOperation({
    summary: 'Alert counts over time by severity, type or domain',
    description:
      'Visible alerts (the tenancy of GET /alerts) per local hour or day of `tz` of their first occurrence, ' +
      'counted by `groupBy`, every bucket from the one containing `from` to the one containing `to` (zeros ' +
      'included). Default range: 7 days (`1d`) or 24 hours (`1h`) up to now; at most 1000 buckets.',
  })
  @ApiOkResponse({ type: AlertSeriesDto })
  async series(
    @Query() query: AlertSeriesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertSeriesDto> {
    const filter = filterOf(query, new Date());
    return new AlertSeriesDto(
      await this.alerts.series(
        {
          filter,
          bucket: query.bucket,
          groupBy: query.groupBy,
          timeZone: query.tz,
        },
        principal,
      ),
    );
  }

  @Get('export.csv')
  @RequirePermissions('alert:read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Export alerts as CSV',
    description:
      'The filters of GET /alerts, newest first, streamed (RFC 4180, UTF-8, CRLF). Column headers follow ' +
      '`Accept-Language` (`id`, default, or `en`); values are the stored codes, UTC ISO-8601 times and the ' +
      'English title and message. At most ALERT_EXPORT_MAX_ROWS rows (default 100 000): more matching alerts ' +
      'set `X-Truncated: true`.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({
    description: 'CSV document (`Content-Disposition: attachment`)',
    content: { 'text/csv': { schema: { type: 'string' } } },
    headers: {
      [TRUNCATED_HEADER]: {
        description: '`true` when more alerts matched than the export carries',
        schema: { type: 'string', enum: ['true'] },
      },
      'Content-Language': {
        description: 'Language of the column headers',
        schema: { type: 'string', enum: ['id', 'en'] },
      },
      'Content-Disposition': {
        description: 'attachment; filename="alerts-<yyyyMMdd-HHmm>.csv"',
        schema: { type: 'string' },
      },
    },
  })
  async exportCsv(
    @Query() query: ExportAlertsQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const now = new Date();
    const locale = preferredLocale(request.headers['accept-language']);
    const exported = await this.alerts.exportCsv(
      filterOf(query, now),
      locale,
      this.config.ALERT_EXPORT_MAX_ROWS,
      principal,
    );
    void reply.header('Content-Language', locale);
    addVary(reply, 'Accept-Language');
    if (exported.truncated) void reply.header(TRUNCATED_HEADER, 'true');
    const stamp = now
      .toISOString()
      .slice(0, 16)
      .replace(/[-:]/g, '')
      .replace('T', '-');
    return new StreamableFile(Readable.from(exported.lines), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="alerts-${stamp}.csv"`,
    });
  }

  @Get(':id/occurrences')
  @RequirePermissions('alert:read')
  @ApiOperation({
    summary: 'Occurrence history of an alert, newest first',
    description:
      'Every alert.raised.v1 stored in the alert: the one that opened it and each merged repeat or escalation, ' +
      'with its own time, severity, texts and measurements (`data`). Detectors publish no de-escalations ' +
      "(the kit's alert emitter only announces raises and escalations), so the history has none. Alerts " +
      'stored before 0.2.0 have no history.',
  })
  @ApiOkResponse({ type: AlertOccurrencePageDto })
  async occurrences(
    @UuidParam() id: string,
    @Query() query: ListOccurrencesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AlertOccurrencePageDto> {
    const after = decodeQueryCursor(query, OccurrenceCursorSchema);
    return new AlertOccurrencePageDto(
      await this.alerts.occurrences(id, after, query.limit, principal),
    );
  }

  @Get(':id')
  @RequirePermissions('alert:read')
  @ApiOperation({ summary: 'Get an alert' })
  @ApiOkResponse({ type: AlertDto })
  async get(
    @UuidParam() id: string,
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
    @UuidParam() id: string,
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
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AlertDto> {
    return new AlertDto(await this.alerts.resolve(id, principal, request));
  }
}
