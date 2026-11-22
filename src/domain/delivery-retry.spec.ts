import { describe, expect, it } from 'vitest';

import { planRetry, type RetryPolicy, retryDelayMs } from './delivery-retry.js';

/** The defaults of `DELIVERY_*` (config.ts). */
const policy: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
};

describe('retryDelayMs (notify.delivery_retry_backoff)', () => {
  it('doubles from the base delay: 30 s, 1 min, 2 min, 4 min, …', () => {
    expect(
      [1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, policy)),
    ).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
  });

  it('is capped at the maximum delay, also for huge attempt numbers', () => {
    expect(retryDelayMs(8, policy)).toBe(3_600_000);
    expect(retryDelayMs(10_000, policy)).toBe(3_600_000);
  });

  it('refuses attempt numbers below 1 or fractional', () => {
    expect(() => retryDelayMs(0, policy)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5, policy)).toThrow(RangeError);
  });
});

describe('planRetry (notify.delivery_retry_backoff)', () => {
  const now = new Date('2026-11-21T08:00:00Z');

  it('schedules the next attempt after the backoff delay', () => {
    expect(planRetry({ attempt: 2, permanent: false }, policy, now)).toEqual({
      status: 'pending',
      nextAttemptAt: new Date('2026-11-21T08:01:00Z'),
    });
  });

  it('honours a longer delay asked by the remote side', () => {
    expect(
      planRetry(
        { attempt: 1, permanent: false, retryAfterMs: 90_000 },
        policy,
        now,
      ),
    ).toEqual({
      status: 'pending',
      nextAttemptAt: new Date('2026-11-21T08:01:30Z'),
    });
    expect(
      planRetry(
        { attempt: 1, permanent: false, retryAfterMs: 1_000 },
        policy,
        now,
      ),
    ).toEqual({
      status: 'pending',
      nextAttemptAt: new Date('2026-11-21T08:00:30Z'),
    });
  });

  it('gives up on permanent failures and after the last attempt', () => {
    expect(planRetry({ attempt: 1, permanent: true }, policy, now)).toEqual({
      status: 'failed',
    });
    expect(planRetry({ attempt: 6, permanent: false }, policy, now)).toEqual({
      status: 'failed',
    });
  });
});
