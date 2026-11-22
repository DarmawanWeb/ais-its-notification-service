import { describe, expect, it } from 'vitest';

import {
  signWebhookPayload,
  verifyWebhookSignature,
  webhookTimestamp,
} from './webhook-signature.js';

const SECRET = 'whsec-test-secret-0123456789';
const TIMESTAMP = '1763712000';
const BODY = '{"event":"test","text":"Halo"}';
/**
 * Computed independently with OpenSSL:
 * `printf '%s' '1763712000.{"event":"test","text":"Halo"}' | openssl dgst -sha256 -hmac 'whsec-test-secret-0123456789'`
 */
const GOLDEN =
  'sha256=0a3c1431fb36c2b20885fc64b7bab805e6f88000ccce6b66b2c6eccbdfd34c67';

describe('signWebhookPayload (notify.webhook_signature)', () => {
  it('signs "<timestamp>.<raw body>" with HMAC-SHA256 (golden value)', () => {
    expect(signWebhookPayload(SECRET, TIMESTAMP, BODY)).toBe(GOLDEN);
    expect(signWebhookPayload(SECRET, TIMESTAMP, Buffer.from(BODY))).toBe(
      GOLDEN,
    );
  });

  it('changes with the timestamp, the body and the secret', () => {
    expect(signWebhookPayload(SECRET, '1763712001', BODY)).not.toBe(GOLDEN);
    expect(signWebhookPayload(SECRET, TIMESTAMP, `${BODY} `)).not.toBe(GOLDEN);
    expect(signWebhookPayload(`${SECRET}x`, TIMESTAMP, BODY)).not.toBe(GOLDEN);
  });
});

describe('verifyWebhookSignature', () => {
  const now = new Date(Number(TIMESTAMP) * 1000 + 60_000);

  it('accepts the signature within the tolerance', () => {
    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, BODY, GOLDEN, { now }),
    ).toBe(true);
  });

  it('rejects a tampered body, another secret or a malformed signature', () => {
    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, '{"event":"x"}', GOLDEN, {
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature('another-secret-0123', TIMESTAMP, BODY, GOLDEN, {
        now,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, BODY, 'sha256=abc', { now }),
    ).toBe(false);
  });

  it('rejects stale or malformed timestamps (replays)', () => {
    const later = new Date(Number(TIMESTAMP) * 1000 + 301_000);

    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, BODY, GOLDEN, { now: later }),
    ).toBe(false);
    expect(
      verifyWebhookSignature(SECRET, TIMESTAMP, BODY, GOLDEN, {
        now: later,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature(SECRET, '17637x2000', BODY, GOLDEN, { now }),
    ).toBe(false);
  });
});

describe('webhookTimestamp', () => {
  it('is the signing time in Unix seconds', () => {
    expect(webhookTimestamp(new Date('2025-11-21T08:00:00.999Z'))).toBe(
      TIMESTAMP,
    );
  });
});
