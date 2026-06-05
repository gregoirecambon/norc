import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';
import { zodMiddleware } from '../lib/validate.js';
import { validateNotionKey } from '../lib/notion-api.js';
import { parsePageId, checkPageAccess, provisionWorkspace, provisionCompanyDb } from '../lib/notion-provision.js';

const router: ExpressRouter = Router();

function getWebhookUrl(): string {
  const base = process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;
  return `${base}/webhooks/notion`;
}

function getIntegration() {
  return db.select().from(notionIntegration).all()[0] ?? null;
}

function getDatabases() {
  return db.select().from(notionDatabases).all().map(d => ({
    kind: d.kind,
    notionDatabaseId: d.notionDatabaseId,
    title: d.title,
    url: d.url,
  }));
}

function safeRow(row: typeof notionIntegration.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    workspaceName: row.workspaceName,
    botName: row.botName,
    webhookVerifyToken: row.webhookVerifyToken,
    webhookUrl: getWebhookUrl(),
    parentPageId: row.parentPageId,
    workspaceStatus: row.workspaceStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// GET /api/notion
router.get('/', (_req, res) => {
  const row = getIntegration();
  res.json({
    integration: row ? safeRow(row) : null,
    webhookUrl: getWebhookUrl(),
    databases: getDatabases(),
  });
});

// POST /api/notion/key
const SaveKeySchema = z.object({ apiKey: z.string().min(1) });

router.post('/key', zodMiddleware(SaveKeySchema), async (req, res) => {
  const { apiKey } = req.body as z.infer<typeof SaveKeySchema>;

  let botInfo: { workspaceName: string; botName: string; botUserId: string | null };
  try {
    botInfo = await validateNotionKey(apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid API key';
    res.status(400).json({ error: 'invalid_key', message: msg });
    return;
  }

  const now = Date.now();
  const existing = getIntegration();

  let row: typeof notionIntegration.$inferSelect;
  if (!existing) {
    const id = randomUUID();
    db.insert(notionIntegration).values({
      id,
      apiKey,
      workspaceName: botInfo.workspaceName,
      botName: botInfo.botName,
      botUserId: botInfo.botUserId,
      status: 'pending_webhook',
      createdAt: now,
      updatedAt: now,
    }).run();
    row = db.select().from(notionIntegration).where(eq(notionIntegration.id, id)).all()[0]!;
  } else {
    db.update(notionIntegration).set({
      apiKey,
      workspaceName: botInfo.workspaceName,
      botName: botInfo.botName,
      botUserId: botInfo.botUserId,
      status: 'pending_webhook',
      webhookVerifyToken: null,
      updatedAt: now,
    }).where(eq(notionIntegration.id, existing.id)).run();
    row = db.select().from(notionIntegration).where(eq(notionIntegration.id, existing.id)).all()[0]!;
  }

  emitLog(`Notion API key validated — workspace: ${botInfo.workspaceName}`);
  emitEvent({ type: 'notion.integration.updated', data: safeRow(row) });

  res.status(201).json(safeRow(row));
});

// POST /api/notion/provision
const ProvisionSchema = z.object({ parentPage: z.string().min(1) });

router.post('/provision', zodMiddleware(ProvisionSchema), async (req, res) => {
  const { parentPage } = req.body as z.infer<typeof ProvisionSchema>;

  const integration = getIntegration();
  if (!integration || integration.status !== 'active') {
    res.status(400).json({ error: 'not_ready', message: 'Connect and verify the Notion webhook first.' });
    return;
  }
  if (integration.workspaceStatus === 'provisioned') {
    res.status(409).json({ error: 'already_provisioned', message: 'Workspace databases already exist. Re-provision to rebuild.' });
    return;
  }

  let pageId: string;
  try {
    pageId = parsePageId(parentPage);
  } catch (err) {
    res.status(400).json({ error: 'bad_page', message: err instanceof Error ? err.message : 'Invalid page' });
    return;
  }

  try {
    await checkPageAccess(integration.apiKey, pageId);
  } catch (err) {
    res.status(400).json({ error: 'no_access', message: err instanceof Error ? err.message : 'No access' });
    return;
  }

  let created;
  try {
    created = await provisionWorkspace(integration.apiKey, pageId);
  } catch (err) {
    res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'Notion API error' });
    return;
  }

  const now = Date.now();
  for (const d of created) {
    db.insert(notionDatabases).values({
      id: randomUUID(),
      kind: d.kind,
      notionDatabaseId: d.notionDatabaseId,
      title: d.title,
      url: d.url,
      createdAt: now,
    }).run();
  }
  db.update(notionIntegration)
    .set({ parentPageId: pageId, workspaceStatus: 'provisioned', updatedAt: now })
    .where(eq(notionIntegration.id, integration.id))
    .run();

  emitLog(`Notion workspace provisioned — ${created.length} databases created`);
  emitEvent({
    type: 'notion.workspace.updated',
    data: { workspaceStatus: 'provisioned', parentPageId: pageId, databases: created },
  });

  res.status(201).json({ databases: created });
});

// POST /api/notion/provision/company — additively add the Company DB to a
// workspace provisioned before strategic context existed. Idempotent.
router.post('/provision/company', async (_req, res) => {
  const integration = getIntegration();
  if (!integration || integration.status !== 'active' || integration.workspaceStatus !== 'provisioned') {
    res.status(400).json({ error: 'not_ready', message: 'Provision the workspace first.' });
    return;
  }
  const existing = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'company')).all()[0];
  if (existing) {
    res.status(200).json({ created: false, database: { kind: 'company', notionDatabaseId: existing.notionDatabaseId, title: existing.title, url: existing.url } });
    return;
  }
  if (!integration.parentPageId) {
    res.status(400).json({ error: 'no_parent', message: 'No parent page recorded; re-provision the workspace.' });
    return;
  }
  const projects = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'projects')).all()[0];

  let created;
  try {
    created = await provisionCompanyDb(integration.apiKey, integration.parentPageId, projects?.notionDatabaseId ?? null);
  } catch (err) {
    res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'Notion API error' });
    return;
  }

  db.insert(notionDatabases).values({
    id: randomUUID(),
    kind: created.kind,
    notionDatabaseId: created.notionDatabaseId,
    title: created.title,
    url: created.url,
    createdAt: Date.now(),
  }).run();

  emitLog('Company DB provisioned (strategic context enabled)');
  emitEvent({
    type: 'notion.workspace.updated',
    data: { workspaceStatus: 'provisioned', parentPageId: integration.parentPageId, databases: getDatabases() },
  });
  res.status(201).json({ created: true, database: created });
});

// DELETE /api/notion
router.delete('/', (_req, res) => {
  db.delete(notionDatabases).run();
  db.delete(notionIntegration).run();
  emitLog('Notion integration removed');
  emitEvent({
    type: 'notion.integration.updated',
    data: {
      status: 'pending_key',
      workspaceName: null,
      botName: null,
      webhookVerifyToken: null,
      webhookUrl: getWebhookUrl(),
    },
  });
  emitEvent({
    type: 'notion.workspace.updated',
    data: { workspaceStatus: 'not_provisioned', parentPageId: null, databases: [] },
  });
  res.json({ deleted: true });
});

export { router as notionRouter };
