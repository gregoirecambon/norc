// Minimal FIFO counting semaphore — bounds how many async jobs run at once.
// Used to gate webhook intake so a bulk Notion drop (e.g. 200 task creations)
// processes a few at a time instead of stampeding the Notion API.

export interface Semaphore {
  /** Run fn once a slot frees up. The slot is released even if fn throws. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Jobs waiting for a slot. */
  pending(): number;
  /** Jobs currently holding a slot. */
  active(): number;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise(resolve => waiters.push(() => { active++; resolve(); }));
  };

  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    pending: () => waiters.length,
    active: () => active,
  };
}
