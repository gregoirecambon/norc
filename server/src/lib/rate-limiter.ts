// Token-bucket rate limiter — paces calls to an external API. Acquires are
// FIFO so callers proceed in arrival order. Notion allows an average of ~3
// requests/second per integration; bursts degrade to latency instead of 429s.

export interface TokenBucket {
  /** Resolves when a token is available (consumes it). */
  acquire(): Promise<void>;
  /** Callers currently waiting for a token. */
  pending(): number;
}

export function createTokenBucket(opts: { capacity: number; refillPerSec: number }): TokenBucket {
  const { capacity, refillPerSec } = opts;
  let tokens = capacity;
  let lastRefill = Date.now();
  const waiters: (() => void)[] = [];
  let timer: NodeJS.Timeout | null = null;

  const refill = (): void => {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
    lastRefill = now;
  };

  const drainWaiters = (): void => {
    timer = null;
    refill();
    while (waiters.length > 0 && tokens >= 1) {
      tokens -= 1;
      waiters.shift()!();
    }
    if (waiters.length > 0) schedule();
  };

  const schedule = (): void => {
    if (timer) return;
    // Time until one whole token exists.
    const deficit = Math.max(0, 1 - tokens);
    const waitMs = Math.max(10, Math.ceil((deficit / refillPerSec) * 1000));
    timer = setTimeout(drainWaiters, waitMs);
    // Don't hold the process open just for pacing.
    timer.unref?.();
  };

  return {
    acquire(): Promise<void> {
      refill();
      if (waiters.length === 0 && tokens >= 1) {
        tokens -= 1;
        return Promise.resolve();
      }
      return new Promise(resolve => {
        waiters.push(resolve);
        schedule();
      });
    },
    pending: () => waiters.length,
  };
}
