import type { Pool } from '@darmawanweb/ais-its-nest/db';
import {
  NonRetryableError,
  RetryableError,
} from '@darmawanweb/ais-its-nest/nats';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../config.js';
import type { NotificationMetrics } from '../../metrics/notification-metrics.js';
import type { DeliveriesRepository } from '../deliveries/deliveries.repository.js';
import { AcceptedEmails } from './accepted-emails.js';
import type {
  EmailAttempt,
  EmailLogEntry,
  EmailLogRepository,
} from './email-log.repository.js';
import { type EmailEnvelope, EmailService } from './email.service.js';
import type { Mailer } from './mailer.service.js';

const DELIVERY = '0193a3c0-0000-7000-8000-0000000000d1';

function envelope(template: 'password_reset' | 'test' = 'password_reset') {
  return {
    id: '0193a3c0-0000-7000-8000-0000000000e1',
    source: 'auth',
    data:
      template === 'password_reset'
        ? {
            to: 'user@example.com',
            template,
            locale: 'en',
            data: { link: 'https://ais-its.example/reset?token=abc' },
          }
        : { to: 'ops@example.com', template, locale: 'id', data: {} },
  } satisfies EmailEnvelope;
}

/** A pool whose clients accept every statement (the repositories are fakes). */
function fakePool() {
  const statements: string[] = [];
  const client = {
    query: vi.fn((text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: () => Promise.resolve(client) } as unknown as Pool,
    statements,
  };
}

function harness(options: {
  readonly recordSent?: () => Promise<void>;
  readonly send?: () => Promise<{ messageId: string }>;
  readonly stored?: Pick<EmailLogEntry, 'status'>;
  /** The row another attempt holds (the claim fails). */
  readonly claimedBy?: Pick<EmailLogEntry, 'status' | 'claimedUntil'>;
}) {
  const { pool, statements } = fakePool();
  const recordSent = options.recordSent ?? (() => Promise.resolve());
  const log = {
    find: vi.fn(() => Promise.resolve(options.stored)),
    claim: vi.fn((_attempt: EmailAttempt, _leaseMs: number) =>
      Promise.resolve(
        options.claimedBy === undefined
          ? { claimed: true as const }
          : { claimed: false as const, entry: options.claimedBy },
      ),
    ),
    recordSent: vi.fn(
      (_attempt: EmailAttempt, _messageId: string, _executor?: unknown) =>
        recordSent(),
    ),
    recordFailure: vi.fn(
      (
        _attempt: EmailAttempt,
        _status: 'retrying' | 'failed',
        _error: string,
        _executor?: unknown,
      ) => Promise.resolve(),
    ),
  };
  const mailer = {
    send: vi.fn(
      options.send ?? (() => Promise.resolve({ messageId: '<m1@mailpit>' })),
    ),
  };
  const deliveries = {
    completeQueued: vi.fn(
      (_id: string, _outcome: unknown, _executor?: unknown) =>
        Promise.resolve(),
    ),
  };
  const service = new EmailService(
    pool,
    log as unknown as EmailLogRepository,
    mailer as unknown as Mailer,
    deliveries as unknown as DeliveriesRepository,
    { emails: { inc: vi.fn() } } as unknown as NotificationMetrics,
    { SMTP_TIMEOUT_MS: 30_000 } as Config,
  );
  return { service, log, mailer, deliveries, statements };
}

const FIRST = { deliveryCount: 1, maxDeliver: 10 };
const SECOND = { deliveryCount: 2, maxDeliver: 10 };

describe('EmailService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('never sends an accepted e-mail again when recording it fails', async () => {
    let failures = 3; // the attempt and both in-place retries
    const { service, log, mailer } = harness({
      recordSent: () =>
        failures-- > 0
          ? Promise.reject(new Error('connection terminated unexpectedly'))
          : Promise.resolve(),
    });

    const first = service.handle(envelope(), FIRST);
    await expect(first).rejects.toBeInstanceOf(RetryableError);
    await expect(first).rejects.toThrow(
      'Recording the sent e-mail failed: connection terminated unexpectedly',
    );
    await expect(first).rejects.not.toThrow(/SMTP/);
    expect(log.recordFailure).not.toHaveBeenCalled();

    // The redelivery only redoes the bookkeeping.
    await expect(service.handle(envelope(), SECOND)).resolves.toBe('sent');
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(log.recordSent).toHaveBeenCalledTimes(4);
    expect(log.recordSent.mock.calls.at(-1)?.[1]).toBe('<m1@mailpit>');
  });

  it('records an accepted alert e-mail and completes its delivery in one transaction', async () => {
    const { service, log, deliveries, statements } = harness({});
    const alertEnvelope = {
      ...envelope(),
      data: {
        to: 'ops@example.com',
        template: 'alert' as const,
        locale: 'en' as const,
        data: {
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
            lastOccurredAt: '2026-11-21T08:15:00.000Z',
            occurrences: 1,
            data: {},
          },
          link: 'https://ais-its.example/alerts?alert=1',
          deliveryId: DELIVERY,
        },
      },
    };

    await expect(service.handle(alertEnvelope, FIRST)).resolves.toBe('sent');

    expect(statements).toEqual(['BEGIN', 'COMMIT']);
    const executor = log.recordSent.mock.calls[0]?.[2];
    expect(executor).toBeDefined();
    expect(deliveries.completeQueued).toHaveBeenCalledWith(
      DELIVERY,
      { sent: true },
      executor,
    );
  });

  it('retries SMTP failures and gives up on the last delivery', async () => {
    const { service, log } = harness({
      send: () => Promise.reject(new Error('421 try again later')),
    });

    await expect(service.handle(envelope(), FIRST)).rejects.toThrow(
      'SMTP: 421 try again later',
    );
    expect(log.recordFailure.mock.calls[0]?.slice(1, 3)).toEqual([
      'retrying',
      'SMTP: 421 try again later',
    ]);

    await expect(
      service.handle(envelope(), { deliveryCount: 10, maxDeliver: 10 }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(log.recordFailure.mock.calls[1]?.[1]).toBe('failed');
    expect(log.recordSent).not.toHaveBeenCalled();
  });

  it('claims the request before the SMTP exchange', async () => {
    const { service, log, mailer } = harness({});

    await service.handle(envelope(), FIRST);

    const [claimed, leaseMs] = log.claim.mock.calls[0] ?? [];
    expect(claimed?.id).toBe(envelope().id);
    expect(claimed?.subject).toBe(
      'Reset your AIS Maritime Intelligence password',
    );
    expect(leaseMs).toBe(120_000);
    expect(log.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mailer.send.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('leaves a request another copy is sending to that copy', async () => {
    const busy = harness({
      claimedBy: {
        status: 'sending',
        claimedUntil: new Date(Date.now() + 60_000),
      },
    });
    const waiting = busy.service.handle(envelope(), SECOND);
    await expect(waiting).rejects.toBeInstanceOf(RetryableError);
    const error: unknown = await waiting.catch((reason: unknown) => reason);
    expect((error as RetryableError).retryAfterMs).toBeGreaterThan(50_000);
    expect(busy.mailer.send).not.toHaveBeenCalled();

    const done = harness({ claimedBy: { status: 'sent', claimedUntil: null } });
    await expect(done.service.handle(envelope(), SECOND)).resolves.toBe(
      'duplicate',
    );
    expect(done.mailer.send).not.toHaveBeenCalled();
  });

  it('skips requests that were sent or failed for good', async () => {
    const { service, mailer } = harness({ stored: { status: 'sent' } });

    await expect(service.handle(envelope(), SECOND)).resolves.toBe('duplicate');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('terminates data the template refuses without sending', async () => {
    const { service, mailer, log } = harness({});
    const invalid = {
      ...envelope(),
      data: { ...envelope().data, data: { link: 'javascript:alert(1)' } },
    };

    await expect(service.handle(invalid, FIRST)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(mailer.send).not.toHaveBeenCalled();
    expect(log.recordFailure.mock.calls[0]?.[1]).toBe('failed');
  });
});

describe('AcceptedEmails', () => {
  it('forgets the oldest entries beyond its capacity', () => {
    const accepted = new AcceptedEmails(2);
    accepted.remember('a', { messageId: '<a>', subject: null });
    accepted.remember('b', { messageId: '<b>', subject: null });
    accepted.remember('c', { messageId: '<c>', subject: 'C' });

    expect(accepted.get('a')).toBeUndefined();
    expect(accepted.get('c')).toEqual({ messageId: '<c>', subject: 'C' });
    accepted.forget('c');
    expect(accepted.get('c')).toBeUndefined();
  });
});
