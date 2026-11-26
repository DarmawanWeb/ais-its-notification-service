import type { CursorPage } from '@darmawanweb/ais-its-contracts/api';
import {
  ALERT_SEVERITIES,
  type AlertSeverity,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  CursorPageInfoDto,
  CursorQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import type { DeliveryStatus } from '../../../db/schema.js';
import type { Delivery } from '../delivery.js';

/** Delivery states. */
export const DELIVERY_STATUSES = [
  'pending',
  'sending',
  'queued',
  'sent',
  'failed',
] as const satisfies readonly DeliveryStatus[];

/** A delivery on the wire. */
export class DeliveryDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ format: 'uuid' })
  readonly alertId: string;

  @ApiProperty({ format: 'uuid' })
  readonly ruleId: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  readonly channel: NotificationChannel;

  @ApiProperty()
  readonly target: string;

  @ApiProperty({
    enum: ALERT_SEVERITIES,
    description: 'Alert severity when the delivery was planned',
  })
  readonly severity: AlertSeverity;

  @ApiProperty({
    enum: DELIVERY_STATUSES,
    description:
      'pending: waiting for an attempt; sending: attempt in progress; queued: e-mail handed to the e-mail pipeline; sent; failed: given up',
  })
  readonly status: DeliveryStatus;

  @ApiProperty({ minimum: 0 })
  readonly attempts: number;

  @ApiProperty({ type: String, nullable: true, description: 'Last error' })
  readonly error: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Next attempt (pending deliveries)',
  })
  readonly nextAttemptAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly lastAttemptAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly sentAt: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt: string;

  constructor(delivery: Delivery) {
    this.id = delivery.id;
    this.alertId = delivery.alertId;
    this.ruleId = delivery.ruleId;
    this.channel = delivery.channel;
    this.target = delivery.target;
    this.severity = delivery.severity;
    this.status = delivery.status;
    this.attempts = delivery.attempts;
    this.error = delivery.error;
    this.nextAttemptAt = delivery.nextAttemptAt.toISOString();
    this.lastAttemptAt = delivery.lastAttemptAt?.toISOString() ?? null;
    this.sentAt = delivery.sentAt?.toISOString() ?? null;
    this.createdAt = delivery.createdAt.toISOString();
  }
}

/** A cursor page of deliveries (spec §5). */
export class DeliveryPageDto implements CursorPage<DeliveryDto> {
  @ApiProperty({ type: [DeliveryDto] })
  readonly data: DeliveryDto[];

  @ApiProperty({ type: CursorPageInfoDto })
  readonly page: CursorPageInfoDto;

  constructor(page: CursorPage<Delivery>) {
    this.data = page.data.map((delivery) => new DeliveryDto(delivery));
    this.page = page.page;
  }
}

/** Query of `GET /notifications/deliveries`. */
export class ListDeliveriesQuery extends CursorQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  readonly ruleId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  readonly alertId?: string;

  @ApiPropertyOptional({ enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsIn(DELIVERY_STATUSES)
  readonly status?: DeliveryStatus;
}

/** Query of `GET /notifications/deliveries/summary`. */
export class DeliverySummaryQuery extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'One rule (default: every rule of the organization)',
  })
  @IsOptional()
  @IsUUID()
  readonly ruleId?: string;
}

/** Counts of `GET /notifications/deliveries/summary` (service result). */
export interface DeliverySummary {
  readonly from: Date;
  readonly to: Date;
  readonly counts: Readonly<Record<DeliveryStatus, number>>;
  readonly lastDeliveredAt: Date | null;
}

/**
 * `GET /notifications/deliveries/summary`: deliveries of the organization's
 * rules planned within `[from, to]`, by status.
 */
export class DeliverySummaryDto {
  @ApiProperty({ format: 'date-time' })
  readonly from: string;

  @ApiProperty({ format: 'date-time' })
  readonly to: string;

  @ApiProperty({
    minimum: 0,
    description: 'Delivered (e-mail: accepted by the SMTP server)',
  })
  readonly sent: number;

  @ApiProperty({ minimum: 0, description: 'Failed for good' })
  readonly failed: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Waiting for their next attempt, or being attempted (`pending` and `sending`)',
  })
  readonly pending: number;

  @ApiProperty({
    minimum: 0,
    description: 'E-mails handed to the e-mail pipeline, not yet sent',
  })
  readonly queued: number;

  @ApiProperty({ minimum: 0 })
  readonly total: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Latest delivery that was sent',
  })
  readonly lastDeliveredAt: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1,
    example: 0.96,
    description: 'sent / (sent + failed), 4 decimals; null while none finished',
  })
  readonly successRate: number | null;

  constructor(summary: DeliverySummary) {
    const { counts } = summary;
    this.from = summary.from.toISOString();
    this.to = summary.to.toISOString();
    this.sent = counts.sent;
    this.failed = counts.failed;
    this.pending = counts.pending + counts.sending;
    this.queued = counts.queued;
    this.total =
      counts.sent +
      counts.failed +
      counts.pending +
      counts.sending +
      counts.queued;
    this.lastDeliveredAt = summary.lastDeliveredAt?.toISOString() ?? null;
    const finished = counts.sent + counts.failed;
    this.successRate =
      finished === 0
        ? null
        : Math.round((counts.sent / finished) * 10_000) / 10_000;
  }
}
