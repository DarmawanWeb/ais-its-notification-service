import { isRole, ROLE_LABELS } from '@darmawanweb/ais-its-contracts/auth';
import type {
  EmailTemplate,
  Locale,
} from '@darmawanweb/ais-its-contracts/domain';
import { RealtimeAlertSchema } from '@darmawanweb/ais-its-contracts/realtime';
import * as z from 'zod';

import { buildAlertMessage } from '../../../domain/alert-message.js';
import { html, type SafeHtml, safeUrl } from './html.js';

/** A rendered e-mail. */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * Optional display text (names, labels): trimmed and clipped to `max`
 * characters; empty, `null` and absent all mean "not given". Cosmetic fields
 * never make an e-mail (a password reset!) undeliverable.
 */
function optionalText(max: number) {
  return z
    .string()
    .nullish()
    .transform((value) => {
      const text = value?.trim().slice(0, max);
      return text === undefined || text === '' ? undefined : text;
    });
}

/** `data` of `password_reset` (sent by auth: `{ name, link, expiresInMinutes }`). */
export const PasswordResetDataSchema = z.object({
  link: HttpUrlSchema,
  name: optionalText(200),
  expiresInMinutes: z.int().min(1).max(10_080).optional(),
});

/** `data` of `account_invite` (sent by auth). */
export const AccountInviteDataSchema = z.object({
  link: HttpUrlSchema,
  name: optionalText(200),
  organizationName: optionalText(200),
  role: optionalText(64),
  invitedBy: optionalText(200),
  expiresInHours: z.int().min(1).max(8_760).optional(),
});

/** `data` of `alert` (sent by this service for e-mail deliveries). */
export const AlertEmailDataSchema = z.object({
  alert: RealtimeAlertSchema,
  link: HttpUrlSchema,
  vesselName: optionalText(200),
  ruleName: optionalText(200),
  /** Delivery the e-mail belongs to (its status is updated after sending). */
  deliveryId: z.uuid().optional(),
});

/** `data` of `test` (`POST /notifications/test`). */
export const TestEmailDataSchema = z.object({
  message: optionalText(500),
  requestedBy: optionalText(200),
});

/** Template data schemas by template name. */
export const TEMPLATE_DATA_SCHEMAS = {
  password_reset: PasswordResetDataSchema,
  account_invite: AccountInviteDataSchema,
  alert: AlertEmailDataSchema,
  test: TestEmailDataSchema,
} as const satisfies Record<EmailTemplate, z.ZodType>;

/** Template data by template name. */
export type TemplateData = {
  [Name in EmailTemplate]: z.output<(typeof TEMPLATE_DATA_SCHEMAS)[Name]>;
};

/** The parts every template provides; the layout turns them into text and HTML. */
interface EmailContent {
  readonly subject: string;
  /** Paragraphs (plain text). */
  readonly paragraphs: readonly string[];
  /** Labelled facts shown as a table. */
  readonly facts?: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Small print below the action. */
  readonly notes?: readonly string[];
}

const BRAND = 'AIS Maritime Intelligence';

const FOOTER: Record<Locale, string> = {
  en: `This e-mail was sent automatically by ${BRAND}. Please do not reply.`,
  id: `E-mail ini dikirim otomatis oleh ${BRAND}. Mohon tidak membalas.`,
};

const COPY_LINK: Record<Locale, string> = {
  en: 'If the button does not work, copy this link into your browser:',
  id: 'Jika tombol tidak berfungsi, salin tautan ini ke peramban Anda:',
};

function greeting(locale: Locale, name: string | undefined): string {
  if (locale === 'id') return name === undefined ? 'Halo,' : `Halo ${name},`;
  return name === undefined ? 'Hello,' : `Hello ${name},`;
}

function passwordReset(
  locale: Locale,
  data: TemplateData['password_reset'],
): EmailContent {
  const minutes = data.expiresInMinutes;
  if (locale === 'id') {
    return {
      subject: `Atur ulang kata sandi ${BRAND}`,
      paragraphs: [
        greeting(locale, data.name),
        'Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda. Gunakan tombol di bawah untuk membuat kata sandi baru.',
        minutes === undefined
          ? 'Tautan hanya dapat digunakan sekali.'
          : `Tautan berlaku ${minutes} menit dan hanya dapat digunakan sekali.`,
      ],
      action: { label: 'Atur ulang kata sandi', url: data.link },
      notes: [
        'Jika Anda tidak meminta ini, abaikan e-mail ini: kata sandi Anda tidak berubah.',
      ],
    };
  }
  return {
    subject: `Reset your ${BRAND} password`,
    paragraphs: [
      greeting(locale, data.name),
      'We received a request to reset the password of your account. Use the button below to choose a new password.',
      minutes === undefined
        ? 'The link can be used once.'
        : `The link is valid for ${minutes} minutes and can be used once.`,
    ],
    action: { label: 'Reset password', url: data.link },
    notes: [
      'If you did not request this, ignore this e-mail: your password stays unchanged.',
    ],
  };
}

function accountInvite(
  locale: Locale,
  data: TemplateData['account_invite'],
): EmailContent {
  const role =
    data.role !== undefined && isRole(data.role)
      ? ROLE_LABELS[data.role][locale]
      : data.role;
  const hours = data.expiresInHours;
  if (locale === 'id') {
    const organization = data.organizationName ?? 'sebuah organisasi';
    return {
      subject:
        data.organizationName === undefined
          ? `Undangan bergabung dengan ${BRAND}`
          : `Undangan bergabung dengan ${data.organizationName} di ${BRAND}`,
      paragraphs: [
        greeting(locale, data.name),
        `${data.invitedBy ?? 'Administrator'} mengundang Anda bergabung dengan ${organization}` +
          `${role === undefined ? '' : ` sebagai ${role}`} di ${BRAND}.`,
        'Gunakan tombol di bawah untuk membuat kata sandi dan mengaktifkan akun Anda.',
        ...(hours === undefined ? [] : [`Undangan berlaku ${hours} jam.`]),
      ],
      action: { label: 'Terima undangan', url: data.link },
      notes: [
        'Jika Anda tidak mengenal pengirim undangan ini, abaikan e-mail ini.',
      ],
    };
  }
  const organization = data.organizationName ?? 'an organization';
  return {
    subject:
      data.organizationName === undefined
        ? `You are invited to ${BRAND}`
        : `You are invited to ${data.organizationName} on ${BRAND}`,
    paragraphs: [
      greeting(locale, data.name),
      `${data.invitedBy ?? 'An administrator'} invited you to join ${organization}` +
        `${role === undefined ? '' : ` as ${role}`} on ${BRAND}.`,
      'Use the button below to choose your password and activate your account.',
      ...(hours === undefined
        ? []
        : [`The invitation is valid for ${hours} hours.`]),
    ],
    action: { label: 'Accept invitation', url: data.link },
    notes: ['If you do not know who sent this invitation, ignore this e-mail.'],
  };
}

function alertEmail(locale: Locale, data: TemplateData['alert']): EmailContent {
  const message = buildAlertMessage(data.alert, {
    locale,
    vesselName: data.vesselName ?? null,
    ruleName: data.ruleName ?? null,
    link: data.link,
  });
  return {
    subject: message.subject,
    paragraphs: [message.heading, message.summary].filter(
      (text) => text !== '',
    ),
    facts: message.lines,
    action: { label: message.linkLabel, url: message.link },
  };
}

function testEmail(locale: Locale, data: TemplateData['test']): EmailContent {
  const extra =
    data.message === undefined || data.message === '' ? [] : [data.message];
  if (locale === 'id') {
    return {
      subject: `Notifikasi uji ${BRAND}`,
      paragraphs: [
        `Ini adalah e-mail uji dari ${BRAND}. Jika Anda menerimanya, notifikasi e-mail ke alamat ini berfungsi.`,
        ...extra,
      ],
      ...(data.requestedBy === undefined
        ? {}
        : { notes: [`Diminta oleh ${data.requestedBy}.`] }),
    };
  }
  return {
    subject: `${BRAND} test notification`,
    paragraphs: [
      `This is a test e-mail from ${BRAND}. If you received it, e-mail notifications to this address work.`,
      ...extra,
    ],
    ...(data.requestedBy === undefined
      ? {}
      : { notes: [`Requested by ${data.requestedBy}.`] }),
  };
}

/** The content of a template for validated data. */
export function templateContent<Name extends EmailTemplate>(
  template: Name,
  locale: Locale,
  data: TemplateData[Name],
): EmailContent {
  // The casts restore the correlation between `template` and `data` that
  // TypeScript loses in a switch over a generic parameter.
  switch (template) {
    case 'password_reset':
      return passwordReset(locale, data as TemplateData['password_reset']);
    case 'account_invite':
      return accountInvite(locale, data as TemplateData['account_invite']);
    case 'alert':
      return alertEmail(locale, data as TemplateData['alert']);
    case 'test':
      return testEmail(locale, data as TemplateData['test']);
  }
}

function layoutHtml(locale: Locale, content: EmailContent): SafeHtml {
  const url =
    content.action === undefined ? undefined : safeUrl(content.action.url);
  const facts =
    content.facts === undefined || content.facts.length === 0
      ? ''
      : html`<table
          role="presentation"
          cellpadding="0"
          cellspacing="0"
          style="width:100%;border-collapse:collapse;margin:8px 0 16px"
        >
          ${content.facts.map(
            (fact) =>
              html`<tr>
                <td
                  style="padding:6px 12px 6px 0;color:#52606d;white-space:nowrap;vertical-align:top"
                >
                  ${fact.label}
                </td>
                <td style="padding:6px 0;color:#1f2933">${fact.value}</td>
              </tr>`,
          )}
        </table>`;
  const action =
    content.action === undefined || url === undefined
      ? ''
      : html`<p style="margin:24px 0">
            <a
              href="${url}"
              style="display:inline-block;padding:12px 20px;background:#0b6fa4;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold"
              >${content.action.label}</a
            >
          </p>
          <p style="margin:0 0 16px;font-size:12px;color:#61707b">
            ${COPY_LINK[locale]}<br /><span style="word-break:break-all"
              >${url}</span
            >
          </p>`;
  const notes = (content.notes ?? []).map(
    (note) =>
      html`<p style="margin:0 0 8px;font-size:13px;color:#61707b">${note}</p>`,
  );
  return html`<!doctype html>
    <html lang="${locale}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${content.subject}</title>
      </head>
      <body
        style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933"
      >
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding:24px 12px">
              <table
                role="presentation"
                cellpadding="0"
                cellspacing="0"
                style="width:100%;max-width:600px;background:#ffffff;border-radius:8px"
              >
                <tr>
                  <td
                    style="padding:18px 24px;background:#0b3d5c;color:#ffffff;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0"
                  >
                    ${BRAND}
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px;font-size:15px;line-height:1.5">
                    ${content.paragraphs.map(
                      (paragraph) =>
                        html`<p style="margin:0 0 12px">${paragraph}</p>`,
                    )}${facts}${action}${notes}
                  </td>
                </tr>
                <tr>
                  <td
                    style="padding:16px 24px;font-size:12px;color:#61707b;border-top:1px solid #e4e7eb"
                  >
                    ${FOOTER[locale]}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html> `;
}

function layoutText(locale: Locale, content: EmailContent): string {
  const blocks: string[] = [...content.paragraphs];
  if (content.facts !== undefined && content.facts.length > 0) {
    blocks.push(
      content.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n'),
    );
  }
  if (content.action !== undefined) {
    blocks.push(`${content.action.label}: ${safeUrl(content.action.url)}`);
  }
  blocks.push(...(content.notes ?? []));
  blocks.push(`--\n${FOOTER[locale]}`);
  return `${blocks.join('\n\n')}\n`;
}

/** Text and HTML of a template's content (the HTML escapes every value). */
export function layoutEmail(
  locale: Locale,
  content: EmailContent,
): RenderedEmail {
  return {
    subject: content.subject.replace(/[\r\n]+/g, ' ').trim(),
    text: layoutText(locale, content),
    html: layoutHtml(locale, content).value,
  };
}
