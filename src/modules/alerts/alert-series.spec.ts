import { describe, expect, it } from 'vitest';

import { assembleSeries } from './alert-series.js';
import type { SeriesCountRow } from './alerts.repository.js';

const KEYS = ['info', 'warning', 'critical'];

function row(
  from: string,
  to: string,
  key: string | null = null,
  count = 0,
): SeriesCountRow {
  return { bucketFrom: new Date(from), bucketTo: new Date(to), key, count };
}

function summary(buckets: ReturnType<typeof assembleSeries>) {
  return buckets.map((bucket) => [
    bucket.from.toISOString(),
    bucket.to.toISOString(),
    bucket.total,
  ]);
}

describe('assembleSeries', () => {
  it('clips the first and last bucket to the range, so the labels match the counts', () => {
    // Counts of [10:30, 11:30]: an alert at 10:40 and one at 11:20 (10:10 is outside).
    const buckets = assembleSeries(
      [
        row('2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', 'warning', 1),
        row('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z', 'critical', 1),
      ],
      KEYS,
      new Date('2026-10-20T10:30:00Z'),
      new Date('2026-10-20T11:30:00Z'),
    );
    expect(summary(buckets)).toEqual([
      ['2026-10-20T10:30:00.000Z', '2026-10-20T11:00:00.000Z', 1],
      ['2026-10-20T11:00:00.000Z', '2026-10-20T11:30:00.000Z', 1],
    ]);
    expect(buckets.map((bucket) => bucket.counts)).toEqual([
      { info: 0, warning: 1, critical: 0 },
      { info: 0, warning: 0, critical: 1 },
    ]);
  });

  it('keeps full buckets inside the range and sums the keys of a bucket', () => {
    const buckets = assembleSeries(
      [
        row('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', 'info', 2),
        row('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', 'warning', 3),
        row('2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z'),
        row('2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z', 'spoofing', 1),
      ],
      [...KEYS, 'spoofing'],
      new Date('2026-10-20T00:00:00Z'),
      new Date('2026-10-22T23:59:59.999Z'),
    );
    expect(summary(buckets)).toEqual([
      ['2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z', 5],
      ['2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z', 0],
      ['2026-10-22T00:00:00.000Z', '2026-10-22T23:59:59.999Z', 1],
    ]);
    expect(buckets[0]?.counts).toEqual({
      info: 2,
      warning: 3,
      critical: 0,
      spoofing: 0,
    });
  });

  it('folds a last bucket starting exactly at `to` into the one before', () => {
    const buckets = assembleSeries(
      [
        row('2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', 'warning', 1),
        row('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z'),
        // An alert at exactly 12:00 (the filter's `to` is inclusive).
        row('2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z', 'critical', 1),
      ],
      KEYS,
      new Date('2026-10-20T10:00:00Z'),
      new Date('2026-10-20T12:00:00Z'),
    );
    expect(summary(buckets)).toEqual([
      ['2026-10-20T10:00:00.000Z', '2026-10-20T11:00:00.000Z', 1],
      ['2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 1],
    ]);
    expect(buckets[1]?.counts).toEqual({ info: 0, warning: 0, critical: 1 });
  });

  it('keeps the single bucket of a range of one instant', () => {
    expect(
      summary(
        assembleSeries(
          [row('2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z', 'info', 1)],
          KEYS,
          new Date('2026-10-20T12:00:00Z'),
          new Date('2026-10-20T12:00:00Z'),
        ),
      ),
    ).toEqual([['2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z', 1]]);
    expect(assembleSeries([], KEYS, new Date(0), new Date(0))).toEqual([]);
  });
});
