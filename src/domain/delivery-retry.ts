/** Retry policy of alert deliveries (`DELIVERY_*` configuration). */
export interface RetryPolicy {
  /** Attempts before a delivery is given up (≥ 1). */
  readonly maxAttempts: number;
  /** Delay after the first failed attempt, ms. */
  readonly baseDelayMs: number;
  /** Upper bound of a delay, ms. */
  readonly maxDelayMs: number;
}

/**
 * Exponential backoff of alert deliveries: after the `attempt`-th failed
 * attempt (1-based) the next one is due after `base × 2^(attempt − 1)`
 * milliseconds, capped at `max` — e.g. 30 s, 1 min, 2 min, 4 min, … with the
 * defaults.
 *
 * @method notify.delivery_retry_backoff
 * @see ../../../../docs/PLATFORM_SPEC.md §13.9 — deliveries "with retries"
 * @param attempt - number of the attempt that failed (≥ 1)
 * @param policy - base and maximum delay, ms
 * @returns the delay before the next attempt, ms
 * @throws RangeError when `attempt` is not a positive integer
 */
export function retryDelayMs(attempt: number, policy: RetryPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  // 2^30 already exceeds any configurable delay; avoid Infinity for huge attempts.
  const factor = 2 ** Math.min(attempt - 1, 30);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * factor);
}

/** A failed attempt as reported by a channel. */
export interface FailedAttempt {
  /** Number of the attempt that failed (≥ 1). */
  readonly attempt: number;
  /** The target refused the message for good (invalid chat, 4xx, …): no retry. */
  readonly permanent: boolean;
  /** Delay the remote side asked for (`retry_after`, `Retry-After`), ms. */
  readonly retryAfterMs?: number | undefined;
}

/** What happens to a delivery after a failed attempt. */
export type RetryDecision =
  | { readonly status: 'failed' }
  | { readonly status: 'pending'; readonly nextAttemptAt: Date };

/**
 * Plans the next attempt of a delivery after a failure: `failed` when the
 * failure is permanent or the attempts are used up, else `pending` with the
 * backoff delay of {@link retryDelayMs} — or the delay the remote side asked
 * for when it is longer (Telegram `retry_after`, HTTP `Retry-After`).
 *
 * @method notify.delivery_retry_backoff
 * @param failure - the failed attempt
 * @param policy - the retry policy
 * @param now - time of the failure
 */
export function planRetry(
  failure: FailedAttempt,
  policy: RetryPolicy,
  now: Date,
): RetryDecision {
  if (failure.permanent || failure.attempt >= policy.maxAttempts) {
    return { status: 'failed' };
  }
  const delay = Math.max(
    retryDelayMs(failure.attempt, policy),
    failure.retryAfterMs ?? 0,
  );
  return { status: 'pending', nextAttemptAt: new Date(now.getTime() + delay) };
}
