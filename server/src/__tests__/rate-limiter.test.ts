import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTokenBucket } from '../lib/rate-limiter.js';

describe('createTokenBucket', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lets a burst of `capacity` through immediately, then makes callers wait', async () => {
    vi.useFakeTimers();
    const bucket = createTokenBucket({ capacity: 3, refillPerSec: 3 });

    let resolved = 0;
    const acquire = () => bucket.acquire().then(() => { resolved++; });
    const all = [acquire(), acquire(), acquire(), acquire()];

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(3);          // burst passes
    expect(bucket.pending()).toBe(1);  // 4th waits

    await vi.advanceTimersByTimeAsync(400); // ~333ms refills one token
    expect(resolved).toBe(4);
    await Promise.all(all);
  });

  it('preserves FIFO order across waits', async () => {
    vi.useFakeTimers();
    const bucket = createTokenBucket({ capacity: 1, refillPerSec: 10 });
    const order: number[] = [];
    const jobs = [1, 2, 3].map(n => bucket.acquire().then(() => order.push(n)));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('sustains roughly the refill rate', async () => {
    vi.useFakeTimers();
    const bucket = createTokenBucket({ capacity: 3, refillPerSec: 3 });
    let resolved = 0;
    const jobs = Array.from({ length: 9 }, () => bucket.acquire().then(() => { resolved++; }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(3);
    await vi.advanceTimersByTimeAsync(1100); // +1s → ~3 more
    expect(resolved).toBeGreaterThanOrEqual(5);
    expect(resolved).toBeLessThanOrEqual(7);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(jobs);
    expect(resolved).toBe(9);
  });
});

describe('notion-client 429 retry', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  it('retries on 429 (honoring Retry-After) and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls <= 2) return jsonRes(429, { message: 'rate limited' }, { 'Retry-After': '0' });
      return jsonRes(200, { object: 'page', id: 'p1' });
    }));
    const { notionGet } = await import('../lib/notion-client.js');
    const res = await notionGet<{ id: string }>('key', '/pages/p1');
    expect(res.id).toBe('p1');
    expect(calls).toBe(3);
  });

  it('gives up after exhausting retries and throws the Notion error', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return jsonRes(429, { message: 'rate limited' }, { 'Retry-After': '0' });
    }));
    const { notionGet } = await import('../lib/notion-client.js');
    await expect(notionGet('key', '/pages/p1')).rejects.toThrow('rate limited');
    expect(calls).toBe(4); // initial + 3 retries
  });
});
