import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';
import { verifyNotionSignature } from '../lib/notion-webhook-verify.js';
import { processWebhookEvent } from '../lib/orchestrator.js';
import { createSemaphore } from '../lib/semaphore.js';

const router: ExpressRouter = Router();

// Bound concurrent event processing so a bulk drop (200 tasks created at once)
// is worked through a few at a time instead of stampeding Notion. Each handler
// already ACKs before this, so Notion never retries while we queue.
const webhookGate = createSemaphore(4);

function getWebhookUrl(): string {
  const base = process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;
  return `${base}/webhooks/notion`;
}

function safeRow(row: typeof notionIntegration.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    workspaceName: row.workspaceName,
    botName: row.botName,
    webhookVerifyToken: row.webhookVerifyToken,
    webhookUrl: getWebhookUrl(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// POST /webhooks/notion
router.post('/', (req, res) => {
  const body = req.body as Record<string, unknown>;

  if (typeof body['verification_token'] === 'string') {
    const token = body['verification_token'];
    const row = db.select().from(notionIntegration).all()[0] ?? null;

    if (!row) {
      res.json({ ok: true });
      return;
    }

    const nowTs = Date.now();
    db.update(notionIntegration)
      .set({ webhookVerifyToken: token, status: 'active', webhookVerifiedAt: nowTs, updatedAt: nowTs })
      .where(eq(notionIntegration.id, row.id))
      .run();

    const updated = db.select().from(notionIntegration).where(eq(notionIntegration.id, row.id)).all()[0]!;

    emitLog('Notion webhook verification token received', 'Notion');
    emitEvent({
      type: 'notion.verification_received',
      data: {
        verificationToken: token,
        workspaceName: updated.workspaceName,
        botName: updated.botName,
      },
    });
    emitEvent({ type: 'notion.integration.updated', data: safeRow(updated) });

    res.json({ ok: true });
    return;
  }

  // Real event — verify the X-Notion-Signature HMAC against the stored
  // verification token before doing anything with the payload.
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const signature = req.header('X-Notion-Signature');
  if (!integration || !verifyNotionSignature(rawBody, signature, integration.webhookVerifyToken)) {
    emitLog(`webhook rejected: ${!integration ? 'no Notion integration configured' : 'invalid or missing signature'}`, 'Notion');
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  // Ack immediately so Notion doesn't retry, then process out of band.
  res.status(200).json({ ok: true });
  if (webhookGate.pending() > 50) {
    emitLog(`webhook intake backlog: ${webhookGate.pending()} events waiting`, 'Notion');
  }
  void webhookGate.run(() => processWebhookEvent(body));
});

export { router as notionWebhookRouter };
