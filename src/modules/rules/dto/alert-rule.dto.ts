import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  type AlertDomain,
  type AlertSeverity,
  LOCALES,
  type Locale,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import { PageMetaDto } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty } from '@nestjs/swagger';

import type { RuleScope } from '../../../domain/alert-rules.js';
import type { AlertRule, RuleChannel } from '../alert-rule.js';

/** A delivery channel on the wire. */
export class RuleChannelViewDto {
  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  readonly type: NotificationChannel;

  @ApiProperty({
    description: 'E-mail address, Telegram chat id / @channel, or webhook URL',
    example: 'ops@example.com',
  })
  readonly target: string;

  constructor(channel: RuleChannel) {
    this.type = channel.type;
    this.target = channel.target;
  }
}

/** An alert rule on the wire. */
export class AlertRuleDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ format: 'uuid', description: 'Owning organization' })
  readonly orgId: string;

  @ApiProperty({ format: 'uuid' })
  readonly createdBy: string;

  @ApiProperty({ example: 'Pipeline danger to the operations room' })
  readonly name: string;

  @ApiProperty({
    enum: ['org', 'all'],
    description: 'org: vessels of the organization; all: every vessel (authority rules)',
  })
  readonly scope: RuleScope;

  @ApiProperty({ type: [String], example: ['ews'], description: 'Empty = every type' })
  readonly types: string[];

  @ApiProperty({ enum: ALERT_DOMAINS, isArray: true, description: 'Empty = every domain' })
  readonly domains: AlertDomain[];

  @ApiProperty({ enum: ALERT_SEVERITIES })
  readonly minSeverity: AlertSeverity;

  @ApiProperty({ type: [Number], example: [525005223], description: 'Empty = every vessel' })
  readonly mmsi: number[];

  @ApiProperty({ type: [String], format: 'uuid', description: 'Empty = every zone' })
  readonly zoneIds: string[];

  @ApiProperty({ type: [RuleChannelViewDto] })
  readonly channels: RuleChannelViewDto[];

  @ApiProperty({ enum: LOCALES, description: 'Language of the notification texts' })
  readonly locale: Locale;

  @ApiProperty({ minimum: 0, maximum: 10_080, description: 'Quiet period, minutes' })
  readonly quietMinutes: number;

  @ApiProperty()
  readonly enabled: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(rule: AlertRule) {
    this.id = rule.id;
    this.orgId = rule.orgId;
    this.createdBy = rule.createdBy;
    this.name = rule.name;
    this.scope = rule.scope;
    this.types = [...rule.types];
    this.domains = [...rule.domains];
    this.minSeverity = rule.minSeverity;
    this.mmsi = [...rule.mmsi];
    this.zoneIds = [...rule.zoneIds];
    this.channels = rule.channels.map((channel) => new RuleChannelViewDto(channel));
    this.locale = rule.locale;
    this.quietMinutes = rule.quietMinutes;
    this.enabled = rule.enabled;
    this.createdAt = rule.createdAt.toISOString();
    this.updatedAt = rule.updatedAt.toISOString();
  }
}

/** A page of alert rules (spec §5). */
export class AlertRulePageDto implements Paginated<AlertRuleDto> {
  @ApiProperty({ type: [AlertRuleDto] })
  readonly data: AlertRuleDto[];

  @ApiProperty({ type: PageMetaDto })
  readonly meta: PageMetaDto;

  constructor(page: Paginated<AlertRule>) {
    this.data = page.data.map((rule) => new AlertRuleDto(rule));
    this.meta = page.meta;
  }
}
