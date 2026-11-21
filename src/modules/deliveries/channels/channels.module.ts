import { Module } from '@nestjs/common';

import { ChannelPolicy } from './channel-policy.js';
import { EmailChannel } from './email.channel.js';
import { TelegramChannel } from './telegram.channel.js';
import { WebhookChannel } from './webhook.channel.js';

/** The delivery channels (e-mail via NOTIFY, Telegram, webhook) and their policy. */
@Module({
  providers: [ChannelPolicy, EmailChannel, TelegramChannel, WebhookChannel],
  exports: [ChannelPolicy, EmailChannel, TelegramChannel, WebhookChannel],
})
export class ChannelsModule {}
