import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  type AlertDomain,
  type AlertSeverity,
  type AlertStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import { CursorPageInfoDto } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';

import {
  localizableTextOf,
  MESSAGE_KEY_PATTERN,
  type MessageParam,
} from '../../../domain/alert-text.js';
import type { AlertSummary, InboxAlert } from '../alert.js';

/** OpenAPI of `messageKey` (alert texts). */
export const MESSAGE_KEY_PROPERTY: ApiPropertyOptions = {
  type: String,
  nullable: true,
  pattern: MESSAGE_KEY_PATTERN.source,
  example: 'safety.ews.anchored_near_pipeline',
  description:
    'Stable key of the text (`<domain>.<detector>.<situation>`, from `data.messageKey`) for clients that ' +
    'localize it; null when the detector sent none or an invalid one (render `title` / `message`)',
};

/** OpenAPI of `messageParams` (alert texts). */
export const MESSAGE_PARAMS_PROPERTY: ApiPropertyOptions = {
  type: 'object',
  nullable: true,
  additionalProperties: {
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  },
  example: { vessel: 'KM Bahari Satu (MMSI 525005223)', distanceM: 840 },
  description:
    'Values of the text (`data.messageParams`, flat strings, numbers and booleans); null together with `messageKey`',
};

/** An alert of the inbox on the wire. */
export class AlertDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Alert id (the first occurrence)',
  })
  readonly id: string;

  @ApiProperty({
    example: 'ews',
    description: 'Alert type (registry ALERT_TYPES; future types possible)',
  })
  readonly type: string;

  @ApiProperty({ enum: ALERT_DOMAINS })
  readonly domain: AlertDomain;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description: 'Highest severity of the merged occurrences',
  })
  readonly severity: AlertSeverity;

  @ApiProperty({ enum: ALERT_STATUSES })
  readonly status: AlertStatus;

  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Second vessel (collision, transhipment)',
  })
  readonly relatedMmsi: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Owner of the vessel',
  })
  readonly orgId: string | null;

  @ApiProperty()
  readonly title: string;

  @ApiProperty()
  readonly message: string;

  @ApiProperty({ type: Number, nullable: true })
  readonly lat: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lon: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly zoneId: string | null;

  @ApiProperty({
    example: 'ews.pipeline_distance_status',
    description: 'Methodology catalog id (spec §17)',
  })
  readonly methodId: string;

  @ApiProperty({
    example: 'ews:525005223:0f6c…',
    description: 'Occurrences with this key merge while unresolved',
  })
  readonly dedupKey: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Detector specific details',
  })
  readonly data: Record<string, unknown>;

  @ApiProperty(MESSAGE_KEY_PROPERTY)
  readonly messageKey: string | null;

  @ApiProperty(MESSAGE_PARAMS_PROPERTY)
  readonly messageParams: Record<string, MessageParam> | null;

  @ApiProperty({ example: 'safety', description: 'Producing service' })
  readonly source: string;

  @ApiProperty({ minimum: 1 })
  readonly occurrences: number;

  @ApiProperty({ format: 'date-time', description: 'First occurrence' })
  readonly occurredAt: string;

  @ApiProperty({ format: 'date-time', description: 'Latest occurrence' })
  readonly lastOccurredAt: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly acknowledgedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly acknowledgedAt: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'User who resolved the alert; null while unresolved and when its detector resolved it (`resolutionEventId` set)',
  })
  readonly resolvedBy: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When it was resolved: the action of the user, or the end of the condition (`resolvedAt` of `alert.resolved.v1`)',
  })
  readonly resolvedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 500,
    example: 'safe: not at anchor within the warning distance',
    description:
      'Why the detector ended the condition (English `reason` of `alert.resolved.v1`); null otherwise',
  })
  readonly resolutionReason: string | null;

  @ApiProperty({
    ...MESSAGE_KEY_PROPERTY,
    example: 'safety.ews.resolved_safe',
    description:
      'Localizable key of `resolutionReason` (`messageKey` in the data of `alert.resolved.v1`); null otherwise',
  })
  readonly resolutionMessageKey: string | null;

  @ApiProperty({
    ...MESSAGE_PARAMS_PROPERTY,
    example: {},
    description: 'Values of `resolutionMessageKey`; null together with it',
  })
  readonly resolutionMessageParams: Record<string, MessageParam> | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Envelope id of the `alert.resolved.v1` that resolved the alert; null when a user resolved it or it is unresolved',
  })
  readonly resolutionEventId: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly updatedAt: string;

  constructor(alert: InboxAlert) {
    this.id = alert.id;
    this.type = alert.type;
    this.domain = alert.domain;
    this.severity = alert.severity;
    this.status = alert.status;
    this.mmsi = alert.mmsi;
    this.relatedMmsi = alert.relatedMmsi;
    this.orgId = alert.orgId;
    this.title = alert.title;
    this.message = alert.message;
    this.lat = alert.lat;
    this.lon = alert.lon;
    this.zoneId = alert.zoneId;
    this.methodId = alert.methodId;
    this.dedupKey = alert.dedupKey;
    this.data = alert.data;
    const text = localizableTextOf(alert.data);
    this.messageKey = text.messageKey;
    this.messageParams =
      text.messageParams === null ? null : { ...text.messageParams };
    this.source = alert.source;
    this.occurrences = alert.occurrences;
    this.occurredAt = alert.occurredAt.toISOString();
    this.lastOccurredAt = alert.lastOccurredAt.toISOString();
    this.acknowledgedBy = alert.acknowledgedBy;
    this.acknowledgedAt = alert.acknowledgedAt?.toISOString() ?? null;
    this.resolvedBy = alert.resolvedBy;
    this.resolvedAt = alert.resolvedAt?.toISOString() ?? null;
    this.resolutionReason = alert.resolutionReason;
    const resolutionText = localizableTextOf(alert.resolutionData);
    this.resolutionMessageKey = resolutionText.messageKey;
    this.resolutionMessageParams =
      resolutionText.messageParams === null
        ? null
        : { ...resolutionText.messageParams };
    this.resolutionEventId = alert.resolutionEventId;
    this.updatedAt = alert.updatedAt.toISOString();
  }
}

/** A cursor page of alerts (spec §5). */
export class AlertPageDto implements CursorPage<AlertDto> {
  @ApiProperty({ type: [AlertDto] })
  readonly data: AlertDto[];

  @ApiProperty({ type: CursorPageInfoDto })
  readonly page: CursorPageInfoDto;

  constructor(page: CursorPage<InboxAlert>) {
    this.data = page.data.map((alert) => new AlertDto(alert));
    this.page = page.page;
  }
}

/** Open alert counts by severity. */
export class SeverityCountsDto {
  @ApiProperty({ minimum: 0 })
  readonly info: number;

  @ApiProperty({ minimum: 0 })
  readonly warning: number;

  @ApiProperty({ minimum: 0 })
  readonly critical: number;

  constructor(counts: Readonly<Record<AlertSeverity, number>>) {
    this.info = counts.info;
    this.warning = counts.warning;
    this.critical = counts.critical;
  }
}

/** Open alert counts by domain. */
export class DomainCountsDto {
  @ApiProperty({ minimum: 0 })
  readonly safety: number;

  @ApiProperty({ minimum: 0 })
  readonly surveillance: number;

  constructor(counts: Readonly<Record<AlertDomain, number>>) {
    this.safety = counts.safety;
    this.surveillance = counts.surveillance;
  }
}

/** `GET /alerts/summary`: open (unacknowledged) alerts visible to the principal. */
export class AlertSummaryDto {
  @ApiProperty({ minimum: 0 })
  readonly total: number;

  @ApiProperty({ type: SeverityCountsDto })
  readonly bySeverity: SeverityCountsDto;

  @ApiProperty({ type: DomainCountsDto })
  readonly byDomain: DomainCountsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { ews: 2, collision: 0, transhipment: 1 },
    description:
      'Every registry type (0 when none) plus any other type present',
  })
  readonly byType: Record<string, number>;

  constructor(summary: AlertSummary) {
    this.total = summary.total;
    this.bySeverity = new SeverityCountsDto(summary.bySeverity);
    this.byDomain = new DomainCountsDto(summary.byDomain);
    this.byType = { ...summary.byType };
  }
}
