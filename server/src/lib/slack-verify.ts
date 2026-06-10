// Verifies the X-Slack-Signature header on incoming Slack event deliveries.
//
// Slack signs each delivery with HMAC-SHA256 over "v0:<timestamp>:<raw body>"
// using the app's signing secret; the header is "v0=<hex>". The timestamp
// header must be within ±5 minutes to defeat replay. Same constant-time
// comparison discipline as notion-webhook-verify.ts.

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_SEC = 300;

export function verifySlackSignature(
  rawBody: Buffer | undefined,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  signingSecret: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!rawBody || !timestampHeader || !signatureHeader || !signingSecret) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > MAX_SKEW_SEC) return false;

  if (!signatureHeader.startsWith('v0=')) return false;
  const provided = signatureHeader.slice('v0='.length);

  const base = Buffer.concat([Buffer.from(`v0:${timestampHeader}:`), rawBody]);
  const expected = createHmac('sha256', signingSecret).update(base).digest('hex');

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
