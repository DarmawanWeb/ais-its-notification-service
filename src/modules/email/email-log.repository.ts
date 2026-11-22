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
  readonly claimedUntil: Date | null;
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

  /**
   * Claims a request for one SMTP exchange of at most `leaseMs`: stores its
   * row as `sending`, or takes over a `retrying` row or a `sending` row whose
   * claim expired (a crashed attempt). `attempts` counts the claims.
   *
   * @returns `claimed`, or the stored row when the request is sent, failed
   *   for good or claimed by another attempt right now
   */
  async claim(
    attempt: EmailAttempt,
    leaseMs: number,
  ): Promise<{ claimed: true } | { claimed: false; entry: EmailLogEntry }> {
    const claimedUntil = sql`now() + make_interval(secs => ${leaseMs / 1000})`;
    const [row] = await this.db
      .insert(emailLog)
      .values({ ...attempt, status: 'sending', attempts: 1, claimedUntil })
      .onConflictDoUpdate({
        target: emailLog.id,
        set: {
          status: 'sending',
          subject: attempt.subject,
          attempts: sql`${emailLog.attempts} + 1`,
          claimedUntil,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${emailLog.status} = 'retrying' OR (${emailLog.status} = 'sending' AND ${emailLog.claimedUntil} < now())`,
      })
      .returning({ id: emailLog.id });
    if (row !== undefined) return { claimed: true };
    const entry = await this.find(attempt.id);
    if (entry === undefined)
      throw new Error(`E-mail ${attempt.id} vanished during its claim`);
    return { claimed: false, entry };
  }

  /**
   * Records an attempt that failed (`retrying` or, finally, `failed`) and
   * releases its claim; data the template refuses is recorded without one.
   */
  async recordFailure(
    attempt: EmailAttempt,
    status: 'retrying' | 'failed',
    error: string,
    executor: Database<typeof schema> = this.db,
  ): Promise<void> {
    await executor
      .insert(emailLog)
      .values({ ...attempt, status, attempts: 1, error })
      .onConflictDoUpdate({
        target: emailLog.id,
        set: {
          status,
          error,
          subject: attempt.subject,
          claimedUntil: null,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Records the attempt the SMTP server accepted and releases its claim. */
  async recordSent(
    attempt: EmailAttempt,
    messageId: string,
    executor: Database<typeof schema> = this.db,
  ): Promise<void> {
    await executor
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
          claimedUntil: null,
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
