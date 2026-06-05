import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyNotionSignature } from '../lib/notion-webhook-verify.js';

const TOKEN = 'verif_token_abc123';

function sign(body: Buffer, token: string): string {
  return 'sha256=' + createHmac('sha256', token).update(body).digest('hex');
}

describe('verifyNotionSignature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'comment.created', entity: { id: 'c1' } }));

  it('accepts a valid signature with the sha256= prefix', () => {
    expect(verifyNotionSignature(body, sign(body, TOKEN), TOKEN)).toBe(true);
  });

  it('accepts a valid signature without the sha256= prefix', () => {
    const raw = createHmac('sha256', TOKEN).update(body).digest('hex');
    expect(verifyNotionSignature(body, raw, TOKEN)).toBe(true);
  });

  it('rejects a signature made with the wrong token', () => {
    expect(verifyNotionSignature(body, sign(body, 'wrong-token'), TOKEN)).toBe(false);
  });

  it('rejects when the body has been tampered with', () => {
    const sig = sign(body, TOKEN);
    const tampered = Buffer.from(body.toString().replace('c1', 'c2'));
    expect(verifyNotionSignature(tampered, sig, TOKEN)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyNotionSignature(body, undefined, TOKEN)).toBe(false);
  });

  it('rejects a missing/empty verification token', () => {
    expect(verifyNotionSignature(body, sign(body, TOKEN), null)).toBe(false);
    expect(verifyNotionSignature(body, sign(body, TOKEN), '')).toBe(false);
  });

  it('rejects a missing raw body', () => {
    expect(verifyNotionSignature(undefined, sign(body, TOKEN), TOKEN)).toBe(false);
  });

  it('rejects a non-hex / garbage signature without throwing', () => {
    expect(verifyNotionSignature(body, 'sha256=not-hex-!!!', TOKEN)).toBe(false);
    expect(verifyNotionSignature(body, 'sha256=', TOKEN)).toBe(false);
  });
});
