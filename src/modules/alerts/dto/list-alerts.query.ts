import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPE_PATTERN,
  type AlertDomain,
  type AlertSeverity,
  type AlertStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { CursorQueryDto, TimeRangeQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/**
 * Query of `GET /alerts` (cursor list, spec §5): `from` / `to` bound the first
 * occurrence (`to` defaults to now, no lower bound by default).
 */
export class ListAlertsQuery extends IntersectionType(CursorQueryDto, TimeRangeQueryDto) {
  @ApiPropertyOptional({ enum: ALERT_STATUSES })
  @IsOptional()
  @IsIn(ALERT_STATUSES)
  readonly status?: AlertStatus;

  @ApiPropertyOptional({ example: 'ews' })
  @IsOptional()
  @Matches(ALERT_TYPE_PATTERN)
  readonly type?: string;

  @ApiPropertyOptional({ enum: ALERT_DOMAINS })
  @IsOptional()
  @IsIn(ALERT_DOMAINS)
  readonly domain?: AlertDomain;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  readonly severity?: AlertSeverity;

  @ApiPropertyOptional({ example: 525005223, description: 'Vessel or related vessel' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;
}
