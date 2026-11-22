import type {
  EmailTemplate,
  Locale,
} from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { eq, lt, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';

const { emailLog } = schema;

/** One transactional e-mail request (`email_log` row, without body). */
export interface EmailLogEntry {
  readonly id: string;
  readonly toAddress: string;
  readonly template: string;
  readonly locale: Locale;
  readonly subject: string | null;
  readonly source: string;
  readonly deliveryId: string | null;
  readonly status: schema.EmailStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly messageId: string | null;
  readonly sentAt: Date | null;
}

/** An attempt to record. */
export interface EmailAttempt {
  readonly id: string;
  readonly toAddress: string;
  readonly template: EmailTemplate;
  readonly locale: Locale;
  readonly subject: string | null;
  readonly source: string;
  readonly deliveryId: string | null;
}

/** Drizzle access to `email_log` (one row per request envelope, idempotency key). */
@Injectable()
export class EmailLogRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async find(id: string): Promise<EmailLogEntry | undefined> {
    const [row] = await this.db
      .select()
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    return row;
  }

  /** Records an attempt that failed (`retrying` or, finally, `failed`). */
  async recordFailure(
    attempt: EmailAttempt,
    status: 'retrying' | 'failed',
    error: string,
  ): Promise<void> {
    await this.db
      .insert(emailLog)
      .values({ ...attempt, status, attempts: 1, error })
      .onConflictDoUpdate({
        target: emailLog.id,
        set: {
          status,
          error,
          subject: attempt.subject,
          attempts: sql`${emailLog.attempts} + 1`,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Records the successful attempt. */
  async recordSent(attempt: EmailAttempt, messageId: string): Promise<void> {
    await this.db
      .insert(emailLog)
      .values({
        ...attempt,
        status: 'sent',
        attempts: 1,
        messageId,
        sentAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: emailLog.id,
        set: {
          status: 'sent',
          error: null,
          subject: attempt.subject,
          messageId,
          sentAt: sql`now()`,
          attempts: sql`${emailLog.attempts} + 1`,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Deletes rows older than `before`. */
  async prune(before: Date): Promise<number> {
    const rows = await this.db
      .delete(emailLog)
      .where(lt(emailLog.createdAt, before))
      .returning({ id: emailLog.id });
    return rows.length;
  }
}
