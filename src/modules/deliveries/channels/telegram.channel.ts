import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import type { Config } from '../../../config.js';
import { type ChannelResult, failed, parseRetryAfter } from './channel-result.js';

/** The part of a Bot API response the channel reads. */
const TelegramResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

/** Cause of a failed `fetch`, without the URL (it holds the bot token). */
function networkError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return cause.code;
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Telegram Bot API channel (`sendMessage`, HTML parse mode). The base URL is
 * configurable (`TELEGRAM_API_BASE`, a fake API in tests); the bot token is
 * part of the URL, so neither the URL nor the token ever reaches logs or
 * stored errors.
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */
@Injectable()
export class TelegramChannel {
  constructor(@InjectConfig() private readonly config: Config) {}

  /**
   * Sends one message: `sent` on `{ ok: true }`; 429 and 5xx are retried
   * (honouring `retry_after`), other refusals (unknown chat, bot blocked, …)
   * are permanent.
   */
  async send(chatId: string, html: string): Promise<ChannelResult> {
    const token = this.config.TELEGRAM_BOT_TOKEN;
    if (token === undefined) {
      return failed('Telegram is not configured (TELEGRAM_BOT_TOKEN)', true);
    }
    const base = this.config.TELEGRAM_API_BASE.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.TELEGRAM_TIMEOUT_MS),
      });
    } catch (error) {
      return failed(`Telegram API unreachable: ${networkError(error)}`, false);
    }
    const parsed = TelegramResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    const description = (parsed.success ? parsed.data.description : undefined)?.replaceAll(
      token,
      '***',
    );
    if (response.ok && parsed.success && parsed.data.ok) return { outcome: 'sent' };
    const detail = `${response.status}${description === undefined ? '' : `: ${description}`}`;
    if (response.status === 429) {
      const retryAfter = parsed.success ? parsed.data.parameters?.retry_after : undefined;
      return failed(
        `Telegram rate limit (${detail})`,
        false,
        retryAfter === undefined
          ? parseRetryAfter(response.headers.get('retry-after'), new Date())
          : retryAfter * 1000,
      );
    }
    if (response.status >= 500) return failed(`Telegram API error (${detail})`, false);
    return failed(`Telegram refused the message (${detail})`, true);
  }
}
