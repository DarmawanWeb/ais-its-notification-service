import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { Config } from '../../config.js';
import type { RenderedEmail } from './templates/templates.js';

/** A message accepted by the SMTP server. */
export interface SentMail {
  readonly messageId: string;
}

/**
 * SMTP sender (`SMTP_URL`, `SMTP_FROM`; Mailpit in development) built on
 * nodemailer. The transport is created in `onModuleInit` and connects per
 * message, so no connection is opened at construction time.
 */
@Injectable()
export class Mailer implements OnModuleInit, OnApplicationShutdown {
  private transport: ReturnType<typeof createTransport> | undefined;

  constructor(@InjectConfig() private readonly config: Config) {}

  onModuleInit(): void {
    this.transport = createTransport(
      {
        url: this.config.SMTP_URL,
        connectionTimeout: this.config.SMTP_TIMEOUT_MS,
        greetingTimeout: this.config.SMTP_TIMEOUT_MS,
        socketTimeout: this.config.SMTP_TIMEOUT_MS,
      },
      { from: this.config.SMTP_FROM },
    );
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }

  /** Sends one e-mail; rejects when the server refuses it or cannot be reached. */
  async send(to: string, email: RenderedEmail): Promise<SentMail> {
    if (this.transport === undefined) throw new Error('The SMTP transport is not initialized');
    const info = await this.transport.sendMail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return { messageId: info.messageId };
  }
}
