import type { Locale } from '@darmawanweb/ais-its-contracts/domain';

import { type AlertMessage, buildAlertMessage } from '../../domain/alert-message.js';
import { formatTelegramAlert } from './channels/telegram-format.js';
import type { DeliveryPayload } from './delivery.js';

/** Event name of a webhook body: `alert.raised`, `alert.escalated`, `alert.recurred`, `test`. */
export type WebhookEvent = `alert.${DeliveryPayload['reason']}` | 'test';

/** The localized message of a delivery. */
export function deliveryMessage(payload: DeliveryPayload): AlertMessage {
  return buildAlertMessage(payload.alert, {
    locale: payload.locale,
    vesselName: payload.vesselName,
    ruleName: payload.ruleName,
    link: payload.link,
  });
}

/** Telegram text of a delivery (HTML parse mode). */
export function telegramText(payload: DeliveryPayload): string {
  return formatTelegramAlert(deliveryMessage(payload));
}

/** Plain-text rendering of a message (webhook `text`). */
export function plainText(message: AlertMessage): string {
  return [
    message.subject,
    message.heading,
    message.summary,
    ...message.lines.map((line) => `${line.label}: ${line.value}`),
    message.link,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * JSON body of an alert webhook (documented in the README): the delivery and
 * rule, the alert as pushed to clients, the vessel, a link and a ready-made
 * text. Receivers verify `X-AIS-ITS-Signature` over the raw body.
 */
export function webhookAlertBody(
  delivery: { readonly id: string; readonly ruleId: string },
  payload: DeliveryPayload,
  sentAt: Date,
): Record<string, unknown> {
  return {
    deliveryId: delivery.id,
    event: `alert.${payload.reason}` satisfies WebhookEvent,
    sentAt: sentAt.toISOString(),
    locale: payload.locale,
    rule: { id: delivery.ruleId, name: payload.ruleName },
    vessel: { mmsi: payload.alert.mmsi, name: payload.vesselName },
    alert: payload.alert,
    link: payload.link,
    text: plainText(deliveryMessage(payload)),
  };
}

const TEST_TEXT: Record<Locale, string> = {
  en: 'AIS Maritime Intelligence test notification: this channel works.',
  id: 'Notifikasi uji AIS Maritime Intelligence: kanal ini berfungsi.',
};

/** Text of a test notification. */
export function testText(locale: Locale): string {
  return TEST_TEXT[locale];
}

/** JSON body of a test webhook. */
export function webhookTestBody(id: string, locale: Locale, sentAt: Date): Record<string, unknown> {
  return {
    deliveryId: id,
    event: 'test' satisfies WebhookEvent,
    sentAt: sentAt.toISOString(),
    locale,
    text: testText(locale),
  };
}
