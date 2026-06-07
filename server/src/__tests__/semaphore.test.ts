import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../lib/semaphore.js';

const tick = () => new Promise<void>(r => setImmediate(r));

describe('createSemaphore', () => {
  it('never runs more than `max` jobs at once', async () => {
    const sem = createSemaphore(4);
    let active = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const jobs = Array.from({ length: 20 }, () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>(r => release.push(r));
        active--;
      }));

    await tick();
    expect(sem.active()).toBe(4);
    expect(sem.pending()).toBe(16);
    expect(peak).toBe(4);

    // Drain everything.
    while (release.length || sem.pending() > 0) {
      release.splice(0).forEach(r => r());
      await tick();
    }
    await Promise.all(jobs);
    expect(peak).toBe(4);
    expect(sem.active()).toBe(0);
  });

  it('runs waiters in FIFO order', async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];
    const jobs = [1, 2, 3].map(n => sem.run(async () => { order.push(n); }));
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('frees the slot when the job throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The slot must be free again.
    const result = await sem.run(async () => 'ok');
    expect(result).toBe('ok');
    expect(sem.active()).toBe(0);
  });
});
