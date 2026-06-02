import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { extractAgentMentions } from '../orchestrator/mention-detector.js';

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
  if (!validateNotionSignature(req)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Acknowledge immediately — Notion expects fast response
  res.status(200).json({ received: true });

  const event = req.body;

  // Only process page_updated events on the Tasks database
  if (event.type !== 'page_updated' && event.type !== 'comment_created') return;

  const pageId: string = event.entity?.id ?? event.page_id;
  if (!pageId) return;

  // Check if this update should trigger an agent (status=Ready + Assigned Agent set)
  // and if any agent is mentioned in comments
  await extractAgentMentions(event, pageId).catch(err => {
    console.error('[webhook] mention extraction failed:', err);
  });
}
