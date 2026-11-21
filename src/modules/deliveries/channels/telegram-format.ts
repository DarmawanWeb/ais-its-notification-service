import type { AlertMessage } from '../../../domain/alert-message.js';

/** Telegram's limit for one message text. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;

/**
 * Escapes text for Telegram's HTML parse mode, which requires `<`, `>` and
 * `&` to be entities (`"` too inside attributes).
 *
 * @see https://core.telegram.org/bots/api#html-style
 */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&quot;',
  );
}

/** Cuts plain text to `max` characters (before escaping, so no entity or tag is split). */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * An alert as a Telegram message (HTML parse mode): bold subject, heading,
 * summary, one line per fact and the link. Free texts are clipped before they
 * are escaped, so the message stays within Telegram's 4 096 characters
 * without splitting an entity or a tag.
 */
export function formatTelegramAlert(message: AlertMessage): string {
  const lines = [
    `<b>${escapeTelegramHtml(clip(message.subject, 256))}</b>`,
    escapeTelegramHtml(clip(message.heading, 512)),
    ...(message.summary === '' ? [] : [escapeTelegramHtml(clip(message.summary, 1_500))]),
    '',
    ...message.lines.map(
      (line) =>
        `<b>${escapeTelegramHtml(clip(line.label, 64))}:</b> ${escapeTelegramHtml(clip(line.value, 200))}`,
    ),
    '',
    `<a href="${escapeTelegramHtml(message.link)}">${escapeTelegramHtml(message.linkLabel)}</a>`,
  ];
  return lines.join('\n');
}
