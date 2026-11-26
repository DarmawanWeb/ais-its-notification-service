import type { NotificationChannel } from '@darmawanweb/ais-its-contracts/domain';
import {
  DomainError,
  InjectConfig,
  ValidationFailedError,
} from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../../config.js';
import type { RuleChannel } from '../../rules/alert-rule.js';
import { channelTargetIssue } from './targets.js';

/** A channel whose configuration is missing (`TELEGRAM_BOT_TOKEN`). */
export class ChannelNotConfiguredError extends DomainError {
  constructor(channels: readonly NotificationChannel[]) {
    super('CHANNEL_NOT_CONFIGURED', {
      status: 422,
      title: 'Channel not configured',
      detail: `The ${channels.join(', ')} channel is not configured on this platform`,
      extra: { channels },
    });
  }
}

/** Which channels can be used and whether a channel's target is acceptable. */
@Injectable()
export class ChannelPolicy {
  constructor(@InjectConfig() private readonly config: Config) {}

  /**
   * E-mail always works, and so do webhooks (every channel gets its own
   * signing key); Telegram needs a bot token.
   */
  isConfigured(type: NotificationChannel): boolean {
    switch (type) {
      case 'email':
      case 'webhook':
        return true;
      case 'telegram':
        return this.config.TELEGRAM_BOT_TOKEN !== undefined;
    }
  }

  /**
   * Checks the channels of a rule (or a test notification).
   *
   * @param field - path of the channels in the request, for field errors
   * @throws {ValidationFailedError} for an invalid target
   * @throws {ChannelNotConfiguredError} for a channel that is not configured
   */
  assertUsable(channels: readonly RuleChannel[], field: string): void {
    const errors = channels.flatMap((channel, index) => {
      const issue = channelTargetIssue(channel.type, channel.target, {
        allowPrivateWebhooks: this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS,
      });
      return issue === null
        ? []
        : [
            {
              field: field === '' ? 'target' : `${field}.${index}.target`,
              message: issue,
            },
          ];
    });
    if (errors.length > 0) throw new ValidationFailedError(errors);
    const missing = [
      ...new Set(
        channels
          .map((channel) => channel.type)
          .filter((type) => !this.isConfigured(type)),
      ),
    ];
    if (missing.length > 0) throw new ChannelNotConfiguredError(missing);
  }
}
