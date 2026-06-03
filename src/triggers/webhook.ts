import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { extractAgentMentions } from '../orchestrator/mention-detector.js';

// In-memory store for the Notion webhook verification token.
// Populated when Notion POSTs { "verification_token": "secret_xxx..." } during setup.
// Consumed (one-shot) by GET /api/init/verify-token once the CLI reads it.
let pendingVerificationToken: string | null = null;

export function getPendingVerificationToken(): string | null {
  return pendingVerificationToken;
}

export function clearPendingVerificationToken(): void {
  pendingVerificationToken = null;
}

export function validateNotionSignature(req: Request): boolean {
  const signature = req.headers['x-notion-signature'] as string;
  const secret = process.env.NOTION_WEBHOOK_SECRET;

  if (!signature || !secret) return false;

  const body = JSON.stringify(req.body);
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function handleNotionWebhook(req: Request, res: Response): Promise<void> {
  const event = req.body;

  // Notion webhook verification handshake: body is { "verification_token": "secret_xxx..." }.
  // Arrives when the user clicks "Verify" in Notion's developer portal.
  // No HMAC secret exists yet at this stage — must skip signature validation.
  if (event?.verification_token && typeof event.verification_token === 'string') {
    pendingVerificationToken = event.verification_token;
    console.log('[webhook] received Notion verification token');
    res.status(200).json({ received: true });
    return;
  }

  if (!validateNotionSignature(req)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Acknowledge immediately — Notion expects fast response
  res.status(200).json({ received: true });

  // Only process page_updated events on the Tasks database
  if (event.type !== 'page_updated' && event.type !== 'comment_created') return;

  const pageId: string = event.entity?.id ?? event.page_id;
  if (!pageId) return;

  await extractAgentMentions(event, pageId).catch(err => {
    console.error('[webhook] mention extraction failed:', err);
  });
}
