/**
 * In-memory sliding-window limit of test notifications per user and
 * instance: a test sends to an arbitrary target (e-mail address, chat, URL),
 * so it must not become a spam or probing tool.
 */
export class TestThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Records an attempt of `key` at `now`.
   *
   * @returns `0` when allowed, else the milliseconds until the next attempt is allowed
   */
  take(key: string, now: number): number {
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, oldest + this.windowMs - now);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, hits] of this.hits) {
      if (hits.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}
