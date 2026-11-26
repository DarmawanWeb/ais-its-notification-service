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
import type { ChannelKeyView } from '../../deliveries/channels/webhook-keys.repository.js';
import type { RuleChannel } from '../alert-rule.js';
import type { AlertRuleView } from '../alert-rules.service.js';

/** A delivery channel on the wire. */
export class RuleChannelViewDto {
  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  readonly type: NotificationChannel;

  @ApiProperty({
    description: 'E-mail address, Telegram chat id / @channel, or webhook URL',
    example: 'ops@example.com',
  })
  readonly target: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Webhooks: id of the signing key, sent as `X-AIS-ITS-Key-Id`; null for other channels and for a webhook ' +
      'from before 0.2.0 (signed with the deployment secret, key id `deployment`, until its secret is rotated)',
  })
  readonly keyId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'whsec_Xb3k…',
    description:
      'Webhooks: the HMAC-SHA256 signing secret, **only** in the response that created the key (POST, a PATCH ' +
      'adding the target, rotate-secret); store it at the receiver, it is never shown again. null otherwise',
  })
  readonly signingSecret: string | null;

  constructor(channel: RuleChannel, key: ChannelKeyView | undefined) {
    this.type = channel.type;
    this.target = channel.target;
    const webhookKey = channel.type === 'webhook' ? key : undefined;
    this.keyId = webhookKey?.keyId ?? null;
    this.signingSecret = webhookKey?.signingSecret ?? null;
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
    description:
      'org: vessels of the organization; all: every vessel (authority rules)',
  })
  readonly scope: RuleScope;

  @ApiProperty({
    type: [String],
    example: ['ews'],
    description: 'Empty = every type',
  })
  readonly types: string[];

  @ApiProperty({
    enum: ALERT_DOMAINS,
    isArray: true,
    description: 'Empty = every domain',
  })
  readonly domains: AlertDomain[];

  @ApiProperty({ enum: ALERT_SEVERITIES })
  readonly minSeverity: AlertSeverity;

  @ApiProperty({
    type: [Number],
    example: [525005223],
    description: 'Empty = every vessel',
  })
  readonly mmsi: number[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Empty = every zone',
  })
  readonly zoneIds: string[];

  @ApiProperty({ type: [RuleChannelViewDto] })
  readonly channels: RuleChannelViewDto[];

  @ApiProperty({
    enum: LOCALES,
    description: 'Language of the notification texts',
  })
  readonly locale: Locale;

  @ApiProperty({
    minimum: 0,
    maximum: 10_080,
    description: 'Quiet period, minutes',
  })
  readonly quietMinutes: number;

  @ApiProperty()
  readonly enabled: boolean;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor({ rule, keys }: AlertRuleView) {
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
    this.channels = rule.channels.map(
      (channel) => new RuleChannelViewDto(channel, keys.get(channel.target)),
    );
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

  constructor(page: Paginated<AlertRuleView>) {
    this.data = page.data.map((rule) => new AlertRuleDto(rule));
    this.meta = page.meta;
  }
}
