import type { EmailRequestedV1 } from '@darmawanweb/ais-its-contracts/events';
import type { RealtimeAlert } from '@darmawanweb/ais-its-contracts/realtime';
import { describe, expect, it } from 'vitest';

import { EmailTemplateDataError, renderEmail } from './render.js';

const RESET_LINK = 'https://ais-its.example/reset-password#token=abc123';

const ALERT: RealtimeAlert = {
  id: '0193a3c0-0000-7000-8000-000000000001',
  type: 'ews',
  domain: 'safety',
  severity: 'critical',
  status: 'open',
  mmsi: 525005223,
  relatedMmsi: null,
  title: 'Anchored 420 m from the pipeline',
  message: 'Predicted at anchor inside the 500 m danger zone',
  lat: -6.2088,
  lon: 106.8456,
  zoneId: null,
  methodId: 'ews.pipeline_distance_status',
  occurredAt: '2026-11-21T08:15:00.000Z',
  lastOccurredAt: '2026-11-21T08:20:00.000Z',
  occurrences: 3,
  data: {},
};

function request(
  template: EmailRequestedV1['template'],
  locale: EmailRequestedV1['locale'],
  data: Record<string, unknown>,
): EmailRequestedV1 {
  return { to: 'user@example.com', template, locale, data };
}

describe('renderEmail', () => {
  it.each(['id', 'en'] as const)('renders password_reset in %s', (locale) => {
    const email = renderEmail(
      request('password_reset', locale, {
        name: 'Siti',
        link: RESET_LINK,
        expiresInMinutes: 30,
      }),
    );

    expect(email.subject).toBe(
      locale === 'id'
        ? 'Atur ulang kata sandi AIS Maritime Intelligence'
        : 'Reset your AIS Maritime Intelligence password',
    );
    expect(email.text).toContain(RESET_LINK);
    expect(email.text).toContain('30');
    expect(email.html).toContain(`href="${RESET_LINK}"`);
    expect(email.html).toContain(`<html lang="${locale}">`);
  });

  it.each(['id', 'en'] as const)('renders account_invite in %s', (locale) => {
    const email = renderEmail(
      request('account_invite', locale, {
        name: 'Budi',
        link: 'https://ais-its.example/accept-invite#token=t',
        organizationName: 'PT Pelayaran Nusantara',
        role: 'fleet_manager',
        invitedBy: 'Admin',
        expiresInHours: 72,
      }),
    );

    expect(email.subject).toContain('PT Pelayaran Nusantara');
    expect(email.text).toContain('72');
    expect(email.text).toContain(
      locale === 'id' ? 'Halo Budi,' : 'Hello Budi,',
    );
    // The role is shown by its label, not its id.
    expect(email.text).not.toContain('fleet_manager');
  });

  it.each(['id', 'en'] as const)('renders alert in %s', (locale) => {
    const email = renderEmail(
      request('alert', locale, {
        alert: ALERT,
        link: 'https://ais-its.example/alerts?alert=0193a3c0',
        vesselName: 'KM Example',
        ruleName: 'Pipeline danger',
        deliveryId: '0193a3c0-0000-7000-8000-0000000000d1',
      }),
    );

    expect(email.subject).toBe(
      locale === 'id'
        ? '[Kritis] Peringatan dini pipa bawah laut — KM Example (525005223)'
        : '[Critical] Pipeline early warning — KM Example (525005223)',
    );
    expect(email.text).toContain('-6.20880, 106.84560');
    expect(email.text).toContain('2026-11-21 08:15:00 UTC');
    expect(email.text).toContain('ews.pipeline_distance_status');
    expect(email.html).toContain('Pipeline danger');
  });

  it.each(['id', 'en'] as const)('renders test in %s', (locale) => {
    const email = renderEmail(
      request('test', locale, { requestedBy: 'Siti <siti@example.com>' }),
    );

    expect(email.subject).toContain('AIS Maritime Intelligence');
    expect(email.html).toContain('Siti &lt;siti@example.com&gt;');
  });

  it('escapes every value in the HTML part', () => {
    const email = renderEmail(
      request('account_invite', 'en', {
        name: '<script>alert("x")</script>',
        link: 'https://ais-its.example/accept-invite#token=t',
        organizationName: `O'Reilly & "Sons" <b>`,
      }),
    );

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(email.html).toContain(
      'O&#39;Reilly &amp; &quot;Sons&quot; &lt;b&gt;',
    );
    // The text part is plain text: no entities.
    expect(email.text).toContain('<script>alert("x")</script>');
  });

  it('keeps headers single-line', () => {
    const email = renderEmail(
      request('account_invite', 'en', {
        link: 'https://ais-its.example/accept-invite#token=t',
        organizationName: 'Evil\r\nBcc: victim@example.com',
      }),
    );

    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it('accepts missing, empty and over-long display names', () => {
    expect(
      renderEmail(request('password_reset', 'en', { link: RESET_LINK })).text,
    ).toContain('Hello,');
    expect(
      renderEmail(
        request('password_reset', 'en', { link: RESET_LINK, name: '  ' }),
      ).text,
    ).toContain('Hello,');
    expect(
      renderEmail(
        request('password_reset', 'en', {
          link: RESET_LINK,
          name: 'x'.repeat(500),
        }),
      ).text,
    ).toContain(`Hello ${'x'.repeat(200)},`);
  });

  it('refuses non-http(s) links and missing required data (never retried)', () => {
    expect(() =>
      renderEmail(
        request('password_reset', 'en', { link: 'javascript:alert(1)' }),
      ),
    ).toThrow(EmailTemplateDataError);
    expect(() => renderEmail(request('password_reset', 'en', {}))).toThrow(
      /link/,
    );
    expect(() =>
      renderEmail(request('alert', 'en', { link: RESET_LINK })),
    ).toThrow(EmailTemplateDataError);
  });
});
