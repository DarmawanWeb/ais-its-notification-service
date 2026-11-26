import type { SeriesCountRow } from './alerts.repository.js';
import type { AlertSeriesBucket } from './dto/alert-series.dto.js';

interface BucketTotals {
  /** Local start of the bucket (`date_trunc`), before clipping. */
  readonly start: number;
  readonly from: Date;
  to: Date;
  total: number;
  readonly counts: Record<string, number>;
}

/**
 * The buckets of `GET /alerts/stats/series`, clipped to the requested range
 * `[from, to]`: the first starts at `from`, the last ends at `to`
 * (inclusive, like the filter), so each bucket's count covers exactly its
 * own `from`–`to` and the totals add up to the alerts that `GET /alerts`
 * lists with the same filters. A last bucket that would start exactly at
 * `to` (zero length) is folded into the one before; the bucket of a range of
 * one instant is kept. `rows` come ordered by bucket start, every bucket at
 * least once (`key` `null` for an empty one, see `AlertsRepository.series`);
 * every key of `keys` is counted in every bucket, zeros included.
 */
export function assembleSeries(
  rows: readonly SeriesCountRow[],
  keys: readonly string[],
  from: Date,
  to: Date,
): AlertSeriesBucket[] {
  const buckets: BucketTotals[] = [];
  for (const row of rows) {
    const start = row.bucketFrom.getTime();
    let bucket = buckets.at(-1);
    if (bucket?.start !== start) {
      bucket = {
        start,
        from: new Date(Math.max(start, from.getTime())),
        to: new Date(Math.min(row.bucketTo.getTime(), to.getTime())),
        total: 0,
        counts: Object.fromEntries(keys.map((key) => [key, 0])),
      };
      buckets.push(bucket);
    }
    if (row.key !== null) {
      bucket.counts[row.key] = (bucket.counts[row.key] ?? 0) + row.count;
      bucket.total += row.count;
    }
  }
  const last = buckets.at(-1);
  const previous = buckets.at(-2);
  if (
    last !== undefined &&
    previous !== undefined &&
    last.from.getTime() >= last.to.getTime()
  ) {
    // `to` is a bucket start: its alerts (at exactly `to`) end the bucket before.
    buckets.pop();
    previous.to = last.to;
    previous.total += last.total;
    for (const [key, count] of Object.entries(last.counts))
      previous.counts[key] = (previous.counts[key] ?? 0) + count;
  }
  return buckets.map((bucket) => ({
    from: bucket.from,
    to: bucket.to,
    total: bucket.total,
    counts: bucket.counts,
  }));
}
