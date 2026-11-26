import { describe, expect, it } from 'vitest';

import { DeliverySummaryDto } from './delivery.dto.js';

const PERIOD = {
  from: new Date('2026-11-01T00:00:00Z'),
  to: new Date('2026-11-23T00:00:00Z'),
};

describe('DeliverySummaryDto', () => {
  it('folds sending into pending and rates sent against finished deliveries', () => {
    expect(
      new DeliverySummaryDto({
        ...PERIOD,
        counts: { pending: 2, sending: 1, queued: 4, sent: 47, failed: 2 },
        lastDeliveredAt: new Date('2026-11-22T10:00:00Z'),
      }),
    ).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-23T00:00:00.000Z',
      sent: 47,
      failed: 2,
      pending: 3,
      queued: 4,
      total: 56,
      lastDeliveredAt: '2026-11-22T10:00:00.000Z',
      successRate: 0.9592,
    });
  });

  it('has no success rate before a delivery finished', () => {
    expect(
      new DeliverySummaryDto({
        ...PERIOD,
        counts: { pending: 1, sending: 0, queued: 0, sent: 0, failed: 0 },
        lastDeliveredAt: null,
      }),
    ).toMatchObject({ successRate: null, lastDeliveredAt: null, total: 1 });
  });
});
