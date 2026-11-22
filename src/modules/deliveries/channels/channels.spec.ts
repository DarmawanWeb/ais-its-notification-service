import { describe, expect, it } from 'vitest';

import type { AlertMessage } from '../../../domain/alert-message.js';
import { parseRetryAfter } from './channel-result.js';
import { channelTargetIssue, isBlockedAddress } from './targets.js';
import {
  escapeTelegramHtml,
  formatTelegramAlert,
  TELEGRAM_MAX_TEXT_LENGTH,
} from './telegram-format.js';

const PUBLIC_ONLY = { allowPrivateWebhooks: false };

describe('channelTargetIssue', () => {
  it('checks e-mail addresses', () => {
    expect(
      channelTargetIssue('email', 'ops@example.com', PUBLIC_ONLY),
    ).toBeNull();
    expect(channelTargetIssue('email', 'ops@', PUBLIC_ONLY)).toMatch(/e-mail/);
  });

  it('checks Telegram chat ids and channel names', () => {
    for (const chat of ['123456789', '-1001234567890', '@ais_ops_room']) {
      expect(channelTargetIssue('telegram', chat, PUBLIC_ONLY)).toBeNull();
    }
    for (const chat of ['@ab', 'chat 1', 'https://t.me/x']) {
      expect(channelTargetIssue('telegram', chat, PUBLIC_ONLY)).not.toBeNull();
    }
  });

  it('accepts public http(s) webhook URLs without credentials', () => {
    expect(
      channelTargetIssue(
        'webhook',
        'https://hooks.example.com/ais',
        PUBLIC_ONLY,
      ),
    ).toBeNull();
    expect(
      channelTargetIssue('webhook', 'ftp://hooks.example.com', PUBLIC_ONLY),
    ).toMatch(/http/);
    expect(
      channelTargetIssue(
        'webhook',
        'https://u:p@hooks.example.com',
        PUBLIC_ONLY,
      ),
    ).toMatch(/credentials/);
    expect(channelTargetIssue('webhook', 'not a url', PUBLIC_ONLY)).toMatch(
      /absolute/,
    );
  });

  it('refuses loopback and private webhook hosts unless allowed (SSRF)', () => {
    for (const url of [
      'http://localhost:8080/hook',
      'http://127.0.0.1/hook',
      'http://10.1.2.3/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hook',
    ]) {
      expect(channelTargetIssue('webhook', url, PUBLIC_ONLY)).toMatch(
        /private/,
      );
      expect(
        channelTargetIssue('webhook', url, { allowPrivateWebhooks: true }),
      ).toBeNull();
    }
  });

  it('bounds the target length', () => {
    expect(channelTargetIssue('email', '', PUBLIC_ONLY)).toMatch(/characters/);
    expect(
      channelTargetIssue(
        'webhook',
        `https://a.example/${'x'.repeat(2_100)}`,
        PUBLIC_ONLY,
      ),
    ).toMatch(/characters/);
  });
});

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '[::1]',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const address of [
      '93.184.216.34',
      '2606:2800:220:1::1',
      '::ffff:8.8.8.8',
    ]) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-11-21T08:00:00Z');

  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Sat, 21 Nov 2026 08:01:00 GMT', now)).toBe(60_000);
  });

  it('ignores missing, invalid, negative and absurd values', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter(String(3 * 86_400), now)).toBeUndefined();
  });
});

describe('Telegram formatting', () => {
  const message: AlertMessage = {
    subject: '[Critical] Pipeline early warning — <KM> & Co',
    heading: 'Pipeline early warning: anchored',
    summary: 'Predicted at anchor',
    lines: [{ label: 'Vessel', value: '<b>KM Example</b> (525005223)' }],
    link: 'https://ais-its.example/alerts?alert=a&b="c"',
    linkLabel: 'Open alert',
  };

  it('escapes every text for the HTML parse mode', () => {
    const text = formatTelegramAlert(message);

    expect(text).toContain(
      '<b>[Critical] Pipeline early warning — &lt;KM&gt; &amp; Co</b>',
    );
    expect(text).toContain(
      '<b>Vessel:</b> &lt;b&gt;KM Example&lt;/b&gt; (525005223)',
    );
    expect(text).toContain(
      '<a href="https://ais-its.example/alerts?alert=a&amp;b=&quot;c&quot;">Open alert</a>',
    );
    expect(escapeTelegramHtml('a<b>&"')).toBe('a&lt;b&gt;&amp;&quot;');
  });

  it('stays within the Telegram message limit for huge texts', () => {
    const text = formatTelegramAlert({
      ...message,
      summary: '<'.repeat(10_000),
      lines: Array.from({ length: 12 }, () => ({
        label: 'x'.repeat(100),
        value: '&'.repeat(1_000),
      })),
    });

    // Telegram counts the visible text: tags removed, entities decoded.
    const visible = text
      .replace(/<[^>]+>/g, '')
      .replace(/&(?:lt|gt|amp|quot);/g, '.');
    expect(visible.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
    expect(visible.length).toBeGreaterThan(4_000);
    expect(text).not.toMatch(/&(?:l|lt|g|gt|a|am|amp|q|qu|quo)?…/);
  });
});
