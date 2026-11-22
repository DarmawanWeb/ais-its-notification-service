import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type EmailRequestedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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
});
