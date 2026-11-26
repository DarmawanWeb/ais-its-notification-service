import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  ALERT_SEVERITIES,
  type AlertSeverity,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  CursorPageInfoDto,
  CursorQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiProperty } from '@nestjs/swagger';

import type { OccurrenceOutcome } from '../../../db/schema.js';
import {
  localizableTextOf,
  type MessageParam,
} from '../../../domain/alert-text.js';
import type { AlertOccurrenceRow } from '../alerts.repository.js';
import { MESSAGE_KEY_PROPERTY, MESSAGE_PARAMS_PROPERTY } from './alert.dto.js';

/** Query of `GET /alerts/:id/occurrences` (cursor list, spec §5). */
export class ListOccurrencesQuery extends CursorQueryDto {}

/** Outcomes of a stored occurrence. */
const OCCURRENCE_OUTCOMES: readonly OccurrenceOutcome[] = [
  'raised',
  'merged',
  'escalated',
];

/** One `alert.raised.v1` of an inbox alert, as it was received. */
export class AlertOccurrenceDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id of the alert.raised.v1 (the first one is the inbox alert id)',
  })
  readonly eventId: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When the detector observed it',
  })
  readonly occurredAt: string;

  @ApiProperty({
    enum: OCCURRENCE_OUTCOMES,
    description:
      'raised: opened the inbox alert; escalated: raised its severity; merged: a repeat',
  })
  readonly outcome: OccurrenceOutcome;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description:
      'Severity of this occurrence (the alert keeps the highest of its occurrences)',
  })
  readonly severity: AlertSeverity;

  @ApiProperty()
  readonly title: string;

  @ApiProperty()
  readonly message: string;

  @ApiProperty(MESSAGE_KEY_PROPERTY)
  readonly messageKey: string | null;

  @ApiProperty(MESSAGE_PARAMS_PROPERTY)
  readonly messageParams: Record<string, MessageParam> | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lat: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly lon: number | null;

  @ApiProperty({ type: Number, nullable: true })
  readonly relatedMmsi: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly zoneId: string | null;

  @ApiProperty({
    example: 'ews.pipeline_distance_status',
    description: 'Methodology catalog id (spec §17)',
  })
  readonly methodId: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Measurements of the detector for this occurrence',
  })
  readonly data: Record<string, unknown>;

  @ApiProperty({
    format: 'date-time',
    description: 'When the inbox stored it',
  })
  readonly receivedAt: string;

  constructor(row: AlertOccurrenceRow) {
    this.eventId = row.eventId;
    this.occurredAt = row.occurredAt.toISOString();
    this.outcome = row.outcome;
    this.severity = row.severity;
    this.title = row.title;
    this.message = row.message;
    const text = localizableTextOf(row.data);
    this.messageKey = text.messageKey;
    this.messageParams =
      text.messageParams === null ? null : { ...text.messageParams };
    this.lat = row.lat;
    this.lon = row.lon;
    this.relatedMmsi = row.relatedMmsi;
    this.zoneId = row.zoneId;
    this.methodId = row.methodId;
    this.data = row.data;
    this.receivedAt = row.receivedAt.toISOString();
  }
}

/** A cursor page of occurrences, newest first (spec §5). */
export class AlertOccurrencePageDto implements CursorPage<AlertOccurrenceDto> {
  @ApiProperty({ type: [AlertOccurrenceDto] })
  readonly data: AlertOccurrenceDto[];

  @ApiProperty({ type: CursorPageInfoDto })
  readonly page: CursorPageInfoDto;

  constructor(page: CursorPage<AlertOccurrenceRow>) {
    this.data = page.data.map((row) => new AlertOccurrenceDto(row));
    this.page = page.page;
  }
}
