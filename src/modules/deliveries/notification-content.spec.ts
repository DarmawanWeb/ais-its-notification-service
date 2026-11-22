import { describe, expect, it } from 'vitest';

import { tokenExpiry } from '../realtime/realtime.gateway.js';
import { type DeliveryPayload, DeliveryPayloadSchema } from './delivery.js';
import {
  telegramText,
  testText,
  webhookAlertBody,
  webhookTestBody,
} from './notification-content.js';
import { TestThrottle } from './test-throttle.js';

const PAYLOAD: DeliveryPayload = DeliveryPayloadSchema.parse({
  reason: 'escalated',
  alert: {
    id: '0193a3c0-0000-7000-8000-000000000001',
    type: 'ews',
    domain: 'safety',
    severity: 'critical',
    status: 'open',
    mmsi: 525005223,
    relatedMmsi: null,
    title: 'Anchored 420 m from the pipeline',
    message: 'Predicted at anchor inside the danger zone',
    lat: -6.2,
    lon: 106.8,
    zoneId: null,
    methodId: 'ews.pipeline_distance_status',
    occurredAt: '2026-11-21T08:15:00.000Z',
    lastOccurredAt: '2026-11-21T08:20:00.000Z',
    occurrences: 2,
    data: {},
  },
  ruleName: 'Pipeline <danger>',
  vesselName: 'KM Example',
  locale: 'en',
  link: 'https://ais-its.example/alerts?alert=0193a3c0',
});

describe('webhook bodies', () => {
  it('describes the delivery, rule, vessel and alert with a ready-made text', () => {
    const body = webhookAlertBody(
      {
        id: '0193a3c0-0000-7000-8000-0000000000d1',
        ruleId: '0193a3c0-0000-7000-8000-0000000000c1',
      },
      PAYLOAD,
      new Date('2026-11-21T08:20:01Z'),
    );

    expect(body).toMatchObject({
      deliveryId: '0193a3c0-0000-7000-8000-0000000000d1',
      event: 'alert.escalated',
      sentAt: '2026-11-21T08:20:01.000Z',
      locale: 'en',
      rule: {
        id: '0193a3c0-0000-7000-8000-0000000000c1',
        name: 'Pipeline <danger>',
      },
      vessel: { mmsi: 525005223, name: 'KM Example' },
      alert: PAYLOAD.alert,
      link: PAYLOAD.link,
    });
    expect(body.text).toContain(
      '[Critical] Pipeline early warning — KM Example (525005223)',
    );
  });

  it('builds the test body in the requested language', () => {
    expect(webhookTestBody('id-1', 'id', new Date(0))).toEqual({
      deliveryId: 'id-1',
      event: 'test',
      sentAt: '1970-01-01T00:00:00.000Z',
      locale: 'id',
      text: testText('id'),
    });
  });
});

describe('telegramText', () => {
  it('escapes the rule name of the delivery', () => {
    expect(telegramText(PAYLOAD)).toContain('Pipeline &lt;danger&gt;');
  });
});

describe('TestThrottle', () => {
  it('allows `limit` attempts per window and tells when the next one is allowed', () => {
    const throttle = new TestThrottle(2, 60_000);

    expect(throttle.take('user', 0)).toBe(0);
    expect(throttle.take('user', 1_000)).toBe(0);
    expect(throttle.take('user', 2_000)).toBe(58_000);
    expect(throttle.take('other', 2_000)).toBe(0);
    expect(throttle.take('user', 60_000)).toBe(0);
  });
});

describe('tokenExpiry', () => {
  it('reads exp of a JWT and tolerates garbage', () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 1_763_712_000 }),
    ).toString('base64url');

    expect(tokenExpiry(`h.${payload}.s`)).toEqual(new Date(1_763_712_000_000));
    expect(tokenExpiry('not-a-jwt')).toBeNull();
    expect(tokenExpiry('h.%%%.s')).toBeNull();
  });
});
