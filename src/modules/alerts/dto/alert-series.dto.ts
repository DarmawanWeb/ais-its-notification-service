import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
} from 'class-validator';

import type { SeriesGroupBy } from '../alerts.repository.js';
import { AlertFilterQuery } from './list-alerts.query.js';

/** Bucket sizes of `GET /alerts/stats/series`. */
export const SERIES_BUCKETS = ['1h', '1d'] as const;

/** A {@link SERIES_BUCKETS} value. */
export type SeriesBucket = (typeof SERIES_BUCKETS)[number];

/** Dimensions of `GET /alerts/stats/series`. */
export const SERIES_GROUP_BY: readonly SeriesGroupBy[] = [
  'severity',
  'type',
  'domain',
];

/** Most buckets one series request may return. */
export const MAX_SERIES_BUCKETS = 1_000;

/**
 * Shape of a time zone name: IANA names start with a letter (`Asia/Jakarta`,
 * `Etc/GMT-7`, `UTC`). UTC offsets such as `+07:00` are refused: ICU accepts
 * them, but PostgreSQL reads them as POSIX zone specifications, whose sign is
 * reversed (`+07:00` would align buckets to UTC-07:00).
 */
export const TIME_ZONE_NAME_PATTERN =
  '^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$';

/**
 * Query of `GET /alerts/stats/series`: the filters of `GET /alerts`; `to`
 * defaults to now, `from` to 7 days (bucket `1d`) or 24 hours (`1h`) before.
 */
export class AlertSeriesQuery extends AlertFilterQuery {
  @ApiPropertyOptional({
    enum: SERIES_BUCKETS,
    default: '1d',
    description: `Bucket size (at most ${MAX_SERIES_BUCKETS} buckets per request, counted after clipping the first and last to the range; more: \`400 VALIDATION_FAILED\`)`,
  })
  @IsOptional()
  @IsIn(SERIES_BUCKETS)
  readonly bucket: SeriesBucket = '1d';

  @ApiPropertyOptional({
    enum: SERIES_GROUP_BY,
    default: 'severity',
    description: 'Dimension of the counts',
  })
  @IsOptional()
  @IsIn(SERIES_GROUP_BY)
  readonly groupBy: SeriesGroupBy = 'severity';

  @ApiPropertyOptional({
    default: 'UTC',
    example: 'Asia/Jakarta',
    maxLength: 64,
    pattern: TIME_ZONE_NAME_PATTERN,
    description:
      'IANA time zone name of the bucket boundaries (local hours and days, e.g. WIB), any case; ' +
      'the response echoes the database spelling. UTC offsets such as `+07:00` are refused (use ' +
      '`Etc/GMT-7`), and so are names the database does not know (`400 VALIDATION_FAILED`)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(new RegExp(TIME_ZONE_NAME_PATTERN), {
    message:
      'tz must be an IANA time zone name (e.g. Asia/Jakarta, Etc/GMT-7), not a UTC offset',
  })
  @IsTimeZone()
  readonly tz: string = 'UTC';
}

/**
 * One bucket of a series: a local hour or day, the first and last clipped to
 * the requested range, so its counts cover exactly `from`–`to`.
 */
export class AlertSeriesBucketDto {
  @ApiProperty({
    format: 'date-time',
    description:
      'Start (inclusive): the local hour or day start; the request `from` for the first bucket',
  })
  readonly from: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'End (exclusive): the next bucket start; the request `to` (inclusive, like the filter) for the last bucket',
  })
  readonly to: string;

  @ApiProperty({
    minimum: 0,
    description: 'Alerts whose first occurrence is in `from`–`to`',
  })
  readonly total: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer', minimum: 0 },
    example: { info: 0, warning: 3, critical: 1 },
    description: 'Count per key of `keys` (0 included)',
  })
  readonly counts: Record<string, number>;

  constructor(bucket: AlertSeriesBucket) {
    this.from = bucket.from.toISOString();
    this.to = bucket.to.toISOString();
    this.total = bucket.total;
    this.counts = { ...bucket.counts };
  }
}

/** A bucket of the series (service result). */
export interface AlertSeriesBucket {
  readonly from: Date;
  readonly to: Date;
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
}

/** The series (service result). */
export interface AlertSeries {
  readonly from: Date;
  readonly to: Date;
  readonly bucket: SeriesBucket;
  readonly groupBy: SeriesGroupBy;
  readonly timeZone: string;
  readonly keys: readonly string[];
  readonly buckets: readonly AlertSeriesBucket[];
}

/** `GET /alerts/stats/series`: alerts per bucket of their first occurrence. */
export class AlertSeriesDto {
  @ApiProperty({ format: 'date-time' })
  readonly from: string;

  @ApiProperty({ format: 'date-time' })
  readonly to: string;

  @ApiProperty({ enum: SERIES_BUCKETS })
  readonly bucket: SeriesBucket;

  @ApiProperty({ enum: SERIES_GROUP_BY })
  readonly groupBy: SeriesGroupBy;

  @ApiProperty({
    example: 'Asia/Jakarta',
    description: 'Time zone of the bucket boundaries (database spelling)',
  })
  readonly timeZone: string;

  @ApiProperty({
    type: [String],
    example: ['info', 'warning', 'critical'],
    description:
      'Keys of `counts`: every registry value of the dimension plus any other type present',
  })
  readonly keys: string[];

  @ApiProperty({ type: [AlertSeriesBucketDto] })
  readonly buckets: AlertSeriesBucketDto[];

  constructor(series: AlertSeries) {
    this.from = series.from.toISOString();
    this.to = series.to.toISOString();
    this.bucket = series.bucket;
    this.groupBy = series.groupBy;
    this.timeZone = series.timeZone;
    this.keys = [...series.keys];
    this.buckets = series.buckets.map(
      (bucket) => new AlertSeriesBucketDto(bucket),
    );
  }
}
