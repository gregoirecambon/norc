import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../lib/slack-verify.js';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

function sign(body: string, ts: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

describe('verifySlackSignature', () => {
  const body = JSON.stringify({ type: 'event_callback', event: { type: 'message', text: 'hi' } });
  const now = 1_900_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it('accepts a valid signature', () => {
    expect(verifySlackSignature(Buffer.from(body), ts, sign(body, ts), SECRET, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySlackSignature(Buffer.from(body + 'x'), ts, sign(body, ts), SECRET, now)).toBe(false);
  });

  it('rejects a signature minted with the wrong secret', () => {
    expect(verifySlackSignature(Buffer.from(body), ts, sign(body, ts, 'wrong-secret'), SECRET, now)).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const staleTs = String(Math.floor(now / 1000) - 301);
    expect(verifySlackSignature(Buffer.from(body), staleTs, sign(body, staleTs), SECRET, now)).toBe(false);
  });

  it('accepts a timestamp just inside the window', () => {
    const okTs = String(Math.floor(now / 1000) - 299);
    expect(verifySlackSignature(Buffer.from(body), okTs, sign(body, okTs), SECRET, now)).toBe(true);
  });

  it('rejects missing inputs', () => {
    expect(verifySlackSignature(undefined, ts, sign(body, ts), SECRET, now)).toBe(false);
    expect(verifySlackSignature(Buffer.from(body), undefined, sign(body, ts), SECRET, now)).toBe(false);
    expect(verifySlackSignature(Buffer.from(body), ts, undefined, SECRET, now)).toBe(false);
    expect(verifySlackSignature(Buffer.from(body), ts, sign(body, ts), null, now)).toBe(false);
  });

  it('rejects a header without the v0= prefix', () => {
    expect(verifySlackSignature(Buffer.from(body), ts, sign(body, ts).slice(3), SECRET, now)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifySlackSignature(Buffer.from(body), 'not-a-ts', sign(body, 'not-a-ts'), SECRET, now)).toBe(false);
  });
});
