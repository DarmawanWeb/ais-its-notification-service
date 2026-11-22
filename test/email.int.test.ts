import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type EmailRequestedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DeliveryWorker } from '../src/modules/deliveries/delivery-worker.service.js';
import { EmailService } from '../src/modules/email/email.service.js';
import { MailpitClient, type MailpitMessage } from './support/receivers.js';
import { startTestService, type TestService } from './support/test-service.js';

interface EmailLogRow {
  readonly status: string;
  readonly template: string;
  readonly locale: string;
  readonly subject: string | null;
  readonly source: string;
  readonly attempts: number;
  readonly error: string | null;
}

describe('transactional e-mail (NOTIFY consumer notification-email)', () => {
  let service: TestService;
  let mailpit: MailpitClient;

  async function requestEmail(
    email: EmailRequestedV1,
    id = newId(),
  ): Promise<string> {
    await service.publisher.publishEvent(
      EVENT_TYPES.NOTIFY_EMAIL_REQUESTED,
      email,
      {
        id,
      },
    );
    return id;
  }

  async function mailTo(address: string): Promise<MailpitMessage> {
    const [message] = await waitFor(async () => {
      const messages = await mailpit.messagesTo(address);
      return messages.length > 0 ? messages : undefined;
    });
    if (message === undefined) throw new Error('unreachable');
    return message;
  }

  async function logRow(id: string, status: string): Promise<EmailLogRow> {
    return waitFor(async () => {
      const { rows } = await service.pool.query<EmailLogRow>(
        `SELECT status, template, locale, subject, source, attempts, error
           FROM email_log WHERE id = $1`,
        [id],
      );
      return rows[0]?.status === status ? rows[0] : undefined;
    });
  }

  beforeAll(async () => {
    mailpit = new MailpitClient(inject('infra').mailpitUrl);
    service = await startTestService();
  });

  afterAll(async () => {
    await service.app.close();
  });

  it('sends a password reset requested by auth, escaped and in the requested language', async () => {
    const to = `reset-${newId()}@example.com`;
    const link = 'http://localhost:8000/reset-password#token=0123456789abcdef';
    const id = await requestEmail({
      to,
      template: 'password_reset',
      locale: 'en',
      data: { name: 'Siti <admin>', link, expiresInMinutes: 30 },
    });

    const mail = await mailTo(to);
    expect(mail.Subject).toBe('Reset your AIS Maritime Intelligence password');
    expect(mail.From).toEqual({
      Address: 'no-reply@ais-its.local',
      Name: 'AIS Maritime Intelligence',
    });
    expect(mail.Text).toContain(link);
    expect(mail.Text).toContain('The link is valid for 30 minutes');
    expect(mail.HTML).toContain('Hello Siti &lt;admin&gt;,');
    expect(mail.HTML).not.toContain('<admin>');

    // The log keeps the request, never the body (it holds the reset token).
    expect(await logRow(id, 'sent')).toEqual({
      status: 'sent',
      template: 'password_reset',
      locale: 'en',
      subject: 'Reset your AIS Maritime Intelligence password',
      source: 'notification',
      attempts: 1,
      error: null,
    });
  });

  it('sends an invitation in Bahasa Indonesia', async () => {
    const to = `invite-${newId()}@example.com`;
    await requestEmail({
      to,
      template: 'account_invite',
      locale: 'id',
      data: {
        name: 'Budi',
        link: 'http://localhost:8000/accept-invite#token=abc',
        organizationName: 'PT Pelayaran Nusantara',
        role: 'fleet_manager',
        invitedBy: 'Admin Armada',
        expiresInHours: 72,
      },
    });

    const mail = await mailTo(to);
    expect(mail.Subject).toBe(
      'Undangan bergabung dengan PT Pelayaran Nusantara di AIS Maritime Intelligence',
    );
    expect(mail.Text).toContain('Halo Budi,');
    expect(mail.Text).toContain('Undangan berlaku 72 jam.');
  });

  it('handles a redelivered request once', async () => {
    const to = `once-${newId()}@example.com`;
    const email: EmailRequestedV1 = {
      to,
      template: 'test',
      locale: 'id',
      data: { requestedBy: 'Integration test' },
    };
    const id = await requestEmail(email);
    await logRow(id, 'sent');

    const outcome = await service.app
      .get(EmailService)
      .handle(
        { id, source: 'notification', data: email },
        { deliveryCount: 2, maxDeliver: 10 },
      );

    expect(outcome).toBe('duplicate');
    expect(await mailpit.messagesTo(to)).toHaveLength(1);
  });

  it('sends two copies of one request handled at the same time once', async () => {
    const to = `copies-${newId()}@example.com`;
    const envelope = {
      id: newId(),
      source: 'auth',
      data: {
        to,
        template: 'test',
        locale: 'en',
        data: { requestedBy: 'Integration test' },
      } satisfies EmailRequestedV1,
    };
    const emails = service.app.get(EmailService);

    const outcomes = await Promise.allSettled([
      emails.handle(envelope, { deliveryCount: 1, maxDeliver: 10 }),
      emails.handle(envelope, { deliveryCount: 1, maxDeliver: 10 }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: 'sent' },
    ]);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(String(rejected?.reason)).toContain(
      'is being sent by another attempt',
    );
    expect(await logRow(envelope.id, 'sent')).toMatchObject({ attempts: 1 });
    await mailTo(to);
    expect(await mailpit.messagesTo(to)).toHaveLength(1);
  });

  it('terminates requests whose data does not fit the template', async () => {
    const id = await requestEmail({
      to: `broken-${newId()}@example.com`,
      template: 'password_reset',
      locale: 'en',
      data: { link: 'javascript:alert(1)' },
    });

    const row = await logRow(id, 'failed');
    expect(row.attempts).toBe(1);
    expect(row.error).toMatch(
      /^Invalid data for e-mail template password_reset: link:/,
    );
  });
  it('queues an alert e-mail again when its NOTIFY request was lost, and sends it once', async () => {
    const ruleId = newId();
    await service.pool.query(
      `INSERT INTO alert_rules (id, org_id, created_by, name, channels)
       VALUES ($1, $2, $3, 'Lost e-mails', '[{"type":"email","target":"x@example.com"}]')`,
      [ruleId, newId(), newId()],
    );
    const lost = { id: newId(), to: `lost-${newId()}@example.com` };
    const expired = { id: newId(), to: `expired-${newId()}@example.com` };
    const alertId = newId();
    const payload = {
      reason: 'raised',
      alert: {
        id: alertId,
        type: 'ews',
        domain: 'safety',
        severity: 'warning',
        status: 'open',
        mmsi: 525005223,
        relatedMmsi: null,
        title: 'Anchored 1.2 km from the pipeline',
        message: 'Predicted at anchor near the pipeline',
        lat: -6.95,
        lon: 112.75,
        zoneId: null,
        methodId: 'ews.pipeline_distance_status',
        occurredAt: new Date().toISOString(),
        lastOccurredAt: new Date().toISOString(),
        occurrences: 1,
        data: {},
      },
      ruleName: 'Lost e-mails',
      vesselName: 'KM Hilang',
      locale: 'en',
      link: `http://localhost:8000/alerts?alert=${alertId}`,
    };
    // Queued two hours ago (and eight days ago), but no request ever reached the consumer.
    for (const [delivery, age] of [
      [lost, '2 hours'],
      [expired, '8 days'],
    ] as const) {
      await service.pool.query(
        `INSERT INTO deliveries (id, alert_id, rule_id, channel, target, severity, status,
                                 attempts, payload, created_at, updated_at)
         VALUES ($1, $2, $3, 'email', $4, 'warning', 'queued', 1, $5,
                 now() - $6::interval, now() - $6::interval)`,
        [delivery.id, alertId, ruleId, delivery.to, payload, age],
      );
    }
    const worker = service.app.get(DeliveryWorker);

    await expect(worker.requeueLostEmails()).resolves.toEqual({
      requeued: 1,
      expired: 1,
    });
    const mail = await mailTo(lost.to);
    expect(mail.Subject).toContain('KM Hilang');
    const status = async (id: string) => {
      const { rows } = await service.pool.query<{ status: string }>(
        'SELECT status FROM deliveries WHERE id = $1',
        [id],
      );
      return rows[0]?.status;
    };
    await waitFor(async () => (await status(lost.id)) === 'sent');
    expect(await status(expired.id)).toBe('failed');

    // Queued again by a second pass or instance: still one e-mail.
    await service.app.get(EmailService).handle(
      {
        id: lost.id,
        source: 'notification',
        data: {
          to: lost.to,
          template: 'alert',
          locale: 'en',
          data: { ...payload, deliveryId: lost.id },
        },
      },
      { deliveryCount: 1, maxDeliver: 10 },
    );
    await expect(worker.requeueLostEmails()).resolves.toEqual({
      requeued: 0,
      expired: 0,
    });
    expect(await mailpit.messagesTo(lost.to)).toHaveLength(1);
  });
});
