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
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : '&quot;',
  );
}

/** Cuts plain text to `max` characters (before escaping, so no entity or tag is split). */
function clip(value: string, max: number): string {
  if (max <= 0) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Hands out the visible characters of one message: Telegram counts the text
 * after entity parsing (tags removed, entities decoded) against
 * {@link TELEGRAM_MAX_TEXT_LENGTH}.
 */
class TextBudget {
  private left = TELEGRAM_MAX_TEXT_LENGTH;

  /** `value` clipped to `max` and to what is left, plus `overhead` characters reserved. */
  take(value: string, max: number, overhead = 1): string {
    const text = clip(value, Math.min(max, this.left - overhead));
    this.left -= text.length + overhead;
    return text;
  }
}

/**
 * An alert as a Telegram message (HTML parse mode): bold subject, heading,
 * summary, one line per fact and the link. Every text is clipped before it is
 * escaped, from one shared budget, so the message never exceeds Telegram's
 * 4 096 characters and no entity or tag is split. The budget goes to the
 * subject, heading, link and facts first; the summary gets the rest.
 */
export function formatTelegramAlert(message: AlertMessage): string {
  const budget = new TextBudget();
  const linkLabel = budget.take(message.linkLabel, 64, 2);
  const subject = budget.take(message.subject, 256);
  const heading = budget.take(message.heading, 512);
  const facts = message.lines
    .map((line) => ({
      label: budget.take(line.label, 64, 3),
      value: budget.take(line.value, 200),
    }))
    .filter((fact) => fact.label !== '');
  const summary = budget.take(message.summary, 1_500);
  const lines = [
    `<b>${escapeTelegramHtml(subject)}</b>`,
    escapeTelegramHtml(heading),
    ...(summary === '' ? [] : [escapeTelegramHtml(summary)]),
    '',
    ...facts.map(
      (fact) =>
        `<b>${escapeTelegramHtml(fact.label)}:</b> ${escapeTelegramHtml(fact.value)}`,
    ),
    '',
    `<a href="${escapeTelegramHtml(message.link)}">${escapeTelegramHtml(linkLabel)}</a>`,
  ];
  return lines.join('\n');
}
