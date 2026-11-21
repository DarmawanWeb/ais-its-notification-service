import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the signature: `sha256=<hex>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-AIS-ITS-Signature';

/** Header carrying the signing time (Unix seconds). */
export const WEBHOOK_TIMESTAMP_HEADER = 'X-AIS-ITS-Timestamp';

/** Header carrying the delivery id (receivers deduplicate retries with it). */
export const WEBHOOK_DELIVERY_HEADER = 'X-AIS-ITS-Delivery';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Signature of a webhook request (spec §13.9): HMAC-SHA256 with
 * `WEBHOOK_SIGNING_SECRET` over `<timestamp>.<raw body>`, hex encoded and
 * prefixed with `sha256=`. Signing the timestamp lets receivers reject
 * replayed requests (see {@link verifyWebhookSignature}).
 *
 * @see https://www.rfc-editor.org/rfc/rfc2104 — HMAC
 * @param secret - the shared signing secret
 * @param timestamp - `X-AIS-ITS-Timestamp`, Unix seconds as sent
 * @param rawBody - the exact request body bytes
 * @returns the `X-AIS-ITS-Signature` value, e.g. `sha256=5d41…`
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return `${SIGNATURE_PREFIX}${hmac.digest('hex')}`;
}

/** Options of {@link verifyWebhookSignature}. */
export interface VerifyWebhookOptions {
  /** Maximum age (and clock skew) of the timestamp, seconds. Default 300. */
  readonly toleranceSeconds?: number | undefined;
  /** Default the current time. */
  readonly now?: Date | undefined;
}

/**
 * Verifies a received webhook (for receivers and tests): the signature must
 * match in constant time and the timestamp must be within the tolerance.
 *
 * @param secret - the shared signing secret
 * @param timestamp - the received `X-AIS-ITS-Timestamp`
 * @param rawBody - the exact received body
 * @param signature - the received `X-AIS-ITS-Signature`
 * @param options - tolerance and clock
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string | Buffer,
  signature: string,
  options: VerifyWebhookOptions = {},
): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, rawBody));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** `X-AIS-ITS-Timestamp` of a signing time: Unix seconds. */
export function webhookTimestamp(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}
