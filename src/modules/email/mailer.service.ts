import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { Config } from '../../config.js';
import type { RenderedEmail } from './templates/templates.js';

/** A message accepted by the SMTP server. */
export interface SentMail {
  readonly messageId: string;
}

/** The SMTP transport of `SMTP_URL` (connects per message, no pool). */
function createSmtpTransport(config: Config) {
  return createTransport(
    {
      url: config.SMTP_URL,
      connectionTimeout: config.SMTP_TIMEOUT_MS,
      greetingTimeout: config.SMTP_TIMEOUT_MS,
      socketTimeout: config.SMTP_TIMEOUT_MS,
    },
    { from: config.SMTP_FROM },
  );
}

/**
 * SMTP sender (`SMTP_URL`, `SMTP_FROM`; Mailpit in development) built on
 * nodemailer. The transport is created in `onModuleInit` and connects per
 * message, so no connection is opened at construction time.
 */
@Injectable()
export class Mailer implements OnModuleInit, OnApplicationShutdown {
  private transport: ReturnType<typeof createSmtpTransport> | undefined;

  constructor(@InjectConfig() private readonly config: Config) {}

  onModuleInit(): void {
    this.transport = createSmtpTransport(this.config);
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }

  /** Sends one e-mail; rejects when the server refuses it or cannot be reached. */
  async send(to: string, email: RenderedEmail): Promise<SentMail> {
    if (this.transport === undefined) {
      throw new Error('The SMTP transport is not initialized');
    }
    const info = await this.transport.sendMail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return { messageId: info.messageId };
  }
}
