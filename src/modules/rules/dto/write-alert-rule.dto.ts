import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  ALERT_TYPE_PATTERN,
  type AlertDomain,
  type AlertSeverity,
  LOCALES,
  type Locale,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type { RuleScope } from '../../../domain/alert-rules.js';
import { MAX_TARGET_LENGTH } from '../../deliveries/channels/targets.js';

/** Trims string input before validation (other values pass unchanged). */
export function trimString(params: TransformFnParams): unknown {
  const input: unknown = params.value;
  return typeof input === 'string' ? input.trim() : input;
}

/** A delivery channel of a rule (the target is checked per type by the service). */
export class RuleChannelDto {
  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  @IsIn(NOTIFICATION_CHANNELS)
  readonly type!: NotificationChannel;

  @ApiProperty({
    description:
      'email: an address; telegram: a chat id or @channel; webhook: an http(s) URL receiving signed JSON POSTs',
    maxLength: MAX_TARGET_LENGTH,
    example: 'ops@example.com',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, MAX_TARGET_LENGTH)
  readonly target!: string;
}

/** `POST /alert-rules`. */
export class CreateAlertRuleDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'Pipeline danger to the operations room',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly name!: string;

  @ApiPropertyOptional({
    enum: ['org', 'all'],
    description:
      'org: vessels of the organization; all: every vessel (authority and super_admin only). ' +
      'Default all for authority principals, else org.',
  })
  @IsOptional()
  @IsIn(['org', 'all'])
  readonly scope?: RuleScope;

  @ApiPropertyOptional({
    type: [String],
    example: ['ews', 'collision'],
    default: [],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ArrayUnique()
  @Matches(ALERT_TYPE_PATTERN, { each: true })
  readonly types?: string[];

  @ApiPropertyOptional({ enum: ALERT_DOMAINS, isArray: true, default: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALERT_DOMAINS, { each: true })
  readonly domains?: AlertDomain[];

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES, default: 'info' })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES)
  readonly minSeverity?: AlertSeverity;

  @ApiPropertyOptional({ type: [Number], example: [525005223], default: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(100_000_000, { each: true })
  @Max(999_999_999, { each: true })
  readonly mmsi?: number[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', default: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly zoneIds?: string[];

  @ApiProperty({ type: [RuleChannelDto], minItems: 1, maxItems: 10 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RuleChannelDto)
  readonly channels!: RuleChannelDto[];

  @ApiPropertyOptional({ enum: LOCALES, default: 'id' })
  @IsOptional()
  @IsIn(LOCALES)
  readonly locale?: Locale;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10_080,
    default: 0,
    description:
      'Quiet period, minutes: an alert is not notified again by this rule within it unless its severity rises',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  readonly quietMinutes?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly enabled?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Owning organization (super_admin only; default the active organization)',
  })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;
}

/**
 * `PATCH /alert-rules/:id`: every field optional. The organization cannot
 * change (`orgId` is not whitelisted, so it is refused with 400).
 */
export class UpdateAlertRuleDto extends PartialType(
  OmitType(CreateAlertRuleDto, ['orgId'] as const),
) {}
