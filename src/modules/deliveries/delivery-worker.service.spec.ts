import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../config.js';
import type { NotificationMetrics } from '../../metrics/notification-metrics.js';
import type { ChannelResult } from './channels/channel-result.js';
import type { EmailChannel } from './channels/email.channel.js';
import type { TelegramChannel } from './channels/telegram.channel.js';
import type { WebhookChannel } from './channels/webhook.channel.js';
import type { WebhookKeysRepository } from './channels/webhook-keys.repository.js';
import type {
  AttemptResult,
  DeliveriesRepository,
} from './deliveries.repository.js';
import type { Delivery } from './delivery.js';
import { DeliveryWorker } from './delivery-worker.service.js';

const PAYLOAD = {
  reason: 'raised',
  alert: {
    id: '0193a3c0-0000-7000-8000-000000000001',
    type: 'ews',
    domain: 'safety',
    severity: 'warning',
    status: 'open',
    mmsi: 525005223,
    relatedMmsi: null,
    title: 'Anchored 1.2 km from the pipeline',
    message: 'Predicted at anchor near the pipeline',
    lat: -6.2,
    lon: 106.8,
    zoneId: null,
    methodId: 'ews.pipeline_distance_status',
    occurredAt: '2026-11-21T08:15:00.000Z',
    lastOccurredAt: '2026-11-21T08:15:00.000Z',
    occurrences: 1,
    data: {},
  },
  ruleName: 'Pipeline warnings',
  vesselName: 'KM Example',
  locale: 'en',
  link: 'https://ais-its.example/alerts?alert=0193a3c0',
};

function delivery(id: string, target: string): Delivery {
  const now = new Date('2026-11-21T08:15:01Z');
  return {
    id,
    alertId: PAYLOAD.alert.id,
    ruleId: '0193a3c0-0000-7000-8000-0000000000c1',
    channel: 'webhook',
    target,
    severity: 'warning',
    status: 'sending',
    attempts: 1,
    error: null,
    payload: PAYLOAD,
    nextAttemptAt: now,
    leaseUntil: now,
    lastAttemptAt: now,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Due deliveries handed out by `claimDue` and the results reported back. */
function fakeRepository(due: Delivery[]) {
  const reports = new Map<string, AttemptResult>();
  const claims: number[] = [];
  const repository = {
    claimDue: vi.fn((limit: number) => {
      claims.push(limit);
      return Promise.resolve(due.splice(0, limit));
    }),
    report: vi.fn((id: string, _attempts: number, result: AttemptResult) => {
      reports.set(id, result);
      return Promise.resolve();
    }),
  };
  return {
    repository: repository as unknown as DeliveriesRepository,
    claimDue: repository.claimDue,
    reports,
    claims,
  };
}

/** A webhook channel whose `slow` target answers only when released. */
function fakeWebhook() {
  let release: ((result: ChannelResult) => void) | undefined;
  const post = vi.fn((url: string) =>
    url.includes('slow')
      ? new Promise<ChannelResult>((resolve) => {
          release = resolve;
        })
      : Promise.resolve<ChannelResult>({ outcome: 'sent' }),
  );
  return {
    channel: { post } as unknown as WebhookChannel,
    post,
    release: (result: ChannelResult) => {
      release?.(result);
    },
  };
}

function worker(repository: DeliveriesRepository, webhook: WebhookChannel) {
  return new DeliveryWorker(
    repository,
    {} as unknown as EmailChannel,
    {} as unknown as TelegramChannel,
    webhook,
    {
      signingKey: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as WebhookKeysRepository,
    {
      notificationsSent: { inc: vi.fn() },
    } as unknown as NotificationMetrics,
    {
      DELIVERY_MAX_ATTEMPTS: 6,
      DELIVERY_RETRY_BASE_MS: 1_000,
      DELIVERY_RETRY_MAX_MS: 60_000,
      DELIVERY_POLL_INTERVAL_MS: 60_000,
      DELIVERY_CONCURRENCY: 2,
      DELIVERY_LEASE_MS: 120_000,
    } as Config,
  );
}

describe('DeliveryWorker', () => {
  let running: DeliveryWorker | undefined;

  afterEach(async () => {
    await running?.beforeApplicationShutdown();
    running = undefined;
  });

  it('keeps delivering through free slots while one receiver is slow', async () => {
    const { repository, reports, claims } = fakeRepository([
      delivery('slow', 'https://slow.example/hook'),
      delivery('a', 'https://a.example/hook'),
      delivery('b', 'https://b.example/hook'),
      delivery('c', 'https://c.example/hook'),
    ]);
    const webhook = fakeWebhook();
    running = worker(repository, webhook.channel);

    running.wake();

    // a, b and c go through the second slot while "slow" holds the first.
    await vi.waitFor(() => {
      expect([...reports.keys()].sort()).toEqual(['a', 'b', 'c']);
    });
    expect(reports.get('a')).toEqual({ status: 'sent' });
    // Never more claimed than slots free: 2, then 1 at a time.
    expect(Math.max(...claims)).toBe(2);
    expect(claims.slice(1).every((limit) => limit === 1)).toBe(true);

    webhook.release({ outcome: 'sent' });
    await vi.waitFor(() => {
      expect(reports.get('slow')).toEqual({ status: 'sent' });
    });
  });

  it('waits for the attempts in flight on shutdown', async () => {
    const { repository, claimDue, reports } = fakeRepository([
      delivery('slow', 'https://slow.example/hook'),
    ]);
    const webhook = fakeWebhook();
    const subject = worker(repository, webhook.channel);
    subject.wake();
    // The attempt is in flight once the channel was called (after its key lookup).
    await vi.waitFor(() => {
      expect(claimDue).toHaveBeenCalled();
      expect(webhook.post).toHaveBeenCalled();
    });

    const stopped = subject.beforeApplicationShutdown();
    webhook.release({ outcome: 'sent' });
    await stopped;

    expect(reports.get('slow')).toEqual({ status: 'sent' });
    subject.wake();
    expect(claimDue).toHaveBeenCalledTimes(1);
  });
});
