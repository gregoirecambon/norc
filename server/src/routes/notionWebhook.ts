import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';

const router: ExpressRouter = Router();

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

    db.update(notionIntegration)
      .set({ webhookVerifyToken: token, status: 'active', updatedAt: Date.now() })
      .where(eq(notionIntegration.id, row.id))
      .run();

    const updated = db.select().from(notionIntegration).where(eq(notionIntegration.id, row.id)).all()[0]!;

    emitLog('Notion webhook verification token received');
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

  // Future: process real webhook events here
  res.json({ ok: true });
});

export { router as notionWebhookRouter };
