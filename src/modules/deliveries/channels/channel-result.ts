/** Outcome of one attempt to hand a notification to a channel. */
export type ChannelResult =
  | { readonly outcome: 'sent' }
  /** Handed to the e-mail pipeline (`NOTIFY`); the e-mail consumer reports the result. */
  | { readonly outcome: 'queued' }
  | {
      readonly outcome: 'failed';
      /** The target refused the message for good: no retry. */
      readonly permanent: boolean;
      /** Safe to store and show: never contains secrets. */
      readonly error: string;
      /** Delay the remote side asked for, ms. */
      readonly retryAfterMs?: number | undefined;
    };

/** A failed result. */
export function failed(
  error: string,
  permanent: boolean,
  retryAfterMs?: number,
): ChannelResult {
  return {
    outcome: 'failed',
    permanent,
    error: error.slice(0, 1_000),
    retryAfterMs,
  };
}

/** `Retry-After` (seconds or HTTP date) in ms, if present and sane (≤ 1 day). */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date,
): number | undefined {
  if (value === null || value === undefined || value.trim() === '')
    return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now.getTime();
  return Number.isFinite(ms) && ms >= 0 && ms <= 86_400_000
    ? Math.ceil(ms)
    : undefined;
}
