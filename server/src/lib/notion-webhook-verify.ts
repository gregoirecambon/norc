// Verifies the X-Notion-Signature header on incoming Notion webhook deliveries.
//
// Notion signs each delivery with HMAC-SHA256 over the *raw* request body, using
// the integration's verification_token as the key. The header value is formatted
// "sha256=<hex>". We compare with crypto.timingSafeEqual to avoid timing leaks.
//
// The verification_token is the same value Notion POSTs once during webhook setup
// and which we persist at notionIntegration.webhookVerifyToken.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyNotionSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  verifyToken: string | null | undefined,
): boolean {
  if (!rawBody || !signatureHeader || !verifyToken) return false;

  // Tolerate a "sha256=" prefix; Notion sends it, but be lenient if absent.
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  const expected = createHmac('sha256', verifyToken).update(rawBody).digest('hex');

  // Compare as fixed-length buffers; mismatched lengths can't be equal.
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
