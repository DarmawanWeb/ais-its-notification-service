import {
  LOCALES,
  type Locale,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@darmawanweb/ais-its-contracts/domain';
import { IsOptionalNotNull } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length } from 'class-validator';

import { trimString } from '../../rules/dto/write-alert-rule.dto.js';
import { MAX_TARGET_LENGTH } from '../channels/targets.js';
import type { TestNotificationResult } from '../notifications.service.js';

/** `POST /notifications/test`. */
export class TestNotificationDto {
  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  @IsIn(NOTIFICATION_CHANNELS)
  readonly channel!: NotificationChannel;

  @ApiProperty({
    description: 'E-mail address, Telegram chat id / @channel, or webhook URL',
    maxLength: MAX_TARGET_LENGTH,
    example: 'ops@example.com',
  })
  @Transform(trimString)
  @IsString()
  @Length(1, MAX_TARGET_LENGTH)
  readonly target!: string;

  @ApiPropertyOptional({ enum: LOCALES, default: 'id' })
  @IsOptionalNotNull()
  @IsIn(LOCALES)
  readonly locale?: Locale;
}

/** Result of a test notification. */
export class TestNotificationResultDto {
  @ApiProperty({ enum: NOTIFICATION_CHANNELS })
  readonly channel: NotificationChannel;

  @ApiProperty()
  readonly target: string;

  @ApiProperty({
    enum: ['sent', 'queued', 'failed'],
    description:
      'queued: the e-mail was handed to the e-mail pipeline (check the inbox)',
  })
  readonly status: 'sent' | 'queued' | 'failed';

  @ApiProperty({ type: String, nullable: true })
  readonly error: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '0193a3c0-0000-7000-8000-0000000000f1',
    description:
      "Webhook tests: the X-AIS-ITS-Key-Id that signed the request — the key of the organization's channel " +
      'with this target, `deployment` for a channel from before 0.2.0, or `test` (a throwaway key: the target ' +
      'is no channel yet, so the request proves reachability only); null for other channels',
  })
  readonly keyId: string | null;

  constructor(result: TestNotificationResult) {
    this.channel = result.channel;
    this.target = result.target;
    this.status = result.status;
    this.error = result.error;
    this.keyId = result.keyId;
  }
}
