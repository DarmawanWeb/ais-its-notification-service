import { Module } from '@nestjs/common';

import { ChannelPolicy } from './channel-policy.js';
import { EmailChannel } from './email.channel.js';
import { TelegramChannel } from './telegram.channel.js';
import { WebhookChannel } from './webhook.channel.js';
import { WebhookKeysRepository } from './webhook-keys.repository.js';

/** The delivery channels (e-mail via NOTIFY, Telegram, webhook), their policy and webhook keys. */
@Module({
  providers: [
    ChannelPolicy,
    EmailChannel,
    TelegramChannel,
    WebhookChannel,
    WebhookKeysRepository,
  ],
  exports: [
    ChannelPolicy,
    EmailChannel,
    TelegramChannel,
    WebhookChannel,
    WebhookKeysRepository,
  ],
})
export class ChannelsModule {}
