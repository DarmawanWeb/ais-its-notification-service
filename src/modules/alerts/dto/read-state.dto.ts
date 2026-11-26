import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of `POST /alerts/read` (optional; validated by the controller, which
 * also accepts a bodiless request).
 */
export class MarkAlertsReadDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Alerts stored or changed up to this time (their `updatedAt`) count as read; default and ' +
      'maximum: now. The mark never moves backwards.',
  })
  readonly upTo?: string;
}

/** `GET /alerts/unread-count`, `POST /alerts/read`. */
export class UnreadCountDto {
  @ApiProperty({
    minimum: 0,
    description:
      'Open alerts visible to the user stored or changed after `readUpTo` (all open alerts without a mark)',
  })
  readonly unread: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Read mark of the user in the active organization; null before the first POST /alerts/read',
  })
  readonly readUpTo: string | null;

  constructor(unread: number, readUpTo: Date | undefined) {
    this.unread = unread;
    this.readUpTo = readUpTo?.toISOString() ?? null;
  }
}
