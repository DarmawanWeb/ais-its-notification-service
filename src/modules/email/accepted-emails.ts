/** What the SMTP server answered for an accepted e-mail. */
export interface AcceptedEmail {
  readonly messageId: string;
  readonly subject: string | null;
}

/** Accepted e-mails remembered at most (the oldest are forgotten first). */
export const MAX_ACCEPTED_EMAILS = 10_000;

/**
 * E-mails the SMTP server accepted but whose bookkeeping failed, by envelope
 * id: a redelivered request found here is recorded without being sent again.
 * In memory and bounded — the database being unavailable is the only reason
 * for an entry, and entries are forgotten once the bookkeeping succeeded.
 */
export class AcceptedEmails {
  private readonly entries = new Map<string, AcceptedEmail>();

  constructor(private readonly capacity: number = MAX_ACCEPTED_EMAILS) {}

  get(envelopeId: string): AcceptedEmail | undefined {
    return this.entries.get(envelopeId);
  }

  remember(envelopeId: string, email: AcceptedEmail): void {
    this.entries.delete(envelopeId);
    this.entries.set(envelopeId, email);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }

  forget(envelopeId: string): void {
    this.entries.delete(envelopeId);
  }
}
