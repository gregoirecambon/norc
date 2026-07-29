// Dashboard management of app principals (non-AI API clients). Owner/admin
// only. The static key is returned exactly once — on create and on rotate —
// and only its hash is stored. Apps sync into the Notion Org DB as Type='App'
// pages (visibility next to humans/agents), which never makes them dispatch
// targets: routing is keyed on the agents table, which apps are not in.

import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apps } from '../db/schema.js';
import { zodMiddleware } from '../lib/validate.js';
import { requireRole, requestUser } from '../lib/user-auth.js';
import { generateAppKey, appScopes, recentAppAccess, APP_SCOPES, type AppRow } from '../lib/apps.js';
import { getOrgContext, upsertAppPage, archiveAgentPage } from '../lib/notion-orgdb.js';
import { emitEvent } from '../lib/events.js';
import { emitLog } from '../lib/logger.js';

const router: ExpressRouter = Router();

const AppBodySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i).min(2).max(60),
  description: z.string().max(500).optional(),
  scopes: z.array(z.enum(APP_SCOPES)).min(1),
});

/** The row as the dashboard sees it — keyPrefix only, never hash or key. */
function publicApp(row: AppRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keyPrefix: row.keyPrefix,
    scopes: appScopes(row),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    orgDbPageId: row.orgDbPageId,
  };
}

/** Mirror the app into the Org DB (Type='App'); swallow errors like agent sync. */
async function syncAppBestEffort(row: AppRow): Promise<void> {
  const ctx = getOrgContext();
  if (!ctx) return;
  try {
    const { pageId } = await upsertAppPage(ctx.apiKey, ctx.orgDbId,
      { name: row.name, description: row.description }, row.orgDbPageId ?? undefined);
    db.update(apps).set({ orgDbPageId: pageId }).where(eq(apps.id, row.id)).run();
    emitEvent({ type: 'app.updated', data: { id: row.id, name: row.name } });
  } catch (err) {
    emitLog(`app "${row.name}" Notion sync failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// GET /api/apps — all apps, active and revoked (revoked kept for audit).
router.get('/', (_req, res) => {
  res.json(db.select().from(apps).all().map(publicApp));
});

// POST /api/apps — create; the ONLY time the full key is returned.
router.post('/', requireRole('owner', 'admin'), zodMiddleware(AppBodySchema), async (req, res) => {
  const { name, description, scopes } = req.body as z.infer<typeof AppBodySchema>;
  if (db.select().from(apps).where(eq(apps.name, name)).all().length > 0) {
    res.status(409).json({ error: 'name_taken', message: `App "${name}" already exists` });
    return;
  }
  const { key, keyHash, keyPrefix } = generateAppKey();
  const row: AppRow = {
    id: randomUUID(),
    name,
    description: description?.trim() || null,
    keyHash,
    keyPrefix,
    scopes: JSON.stringify(scopes),
    createdBy: requestUser(req).id,
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
    orgDbPageId: null,
  };
  db.insert(apps).values(row).run();
  emitLog(`app "${name}" created (scopes: ${scopes.join(', ')})`);
  emitEvent({ type: 'app.created', data: { id: row.id, name } });
  void syncAppBestEffort(row);
  res.status(201).json({ ...publicApp(row), key });
});

// PATCH /api/apps/:id — update description/scopes.
router.patch('/:id', requireRole('owner', 'admin'), zodMiddleware(AppBodySchema.partial().omit({ name: true })), async (req, res) => {
  const id = (req.params as { id: string }).id;
  const row = db.select().from(apps).where(eq(apps.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  const { description, scopes } = req.body as { description?: string; scopes?: string[] };
  const patch: Partial<AppRow> = {};
  if (description !== undefined) patch.description = description.trim() || null;
  if (scopes !== undefined) patch.scopes = JSON.stringify(scopes);
  if (Object.keys(patch).length) db.update(apps).set(patch).where(eq(apps.id, id)).run();
  const fresh = db.select().from(apps).where(eq(apps.id, id)).all()[0]!;
  emitEvent({ type: 'app.updated', data: { id, name: fresh.name } });
  res.json(publicApp(fresh));
});

// POST /api/apps/:id/rotate — mint a fresh key (old one dies instantly).
router.post('/:id/rotate', requireRole('owner', 'admin'), (req, res) => {
  const id = (req.params as { id: string }).id;
  const row = db.select().from(apps).where(eq(apps.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  const { key, keyHash, keyPrefix } = generateAppKey();
  db.update(apps).set({ keyHash, keyPrefix, revokedAt: null }).where(eq(apps.id, id)).run();
  emitLog(`app "${row.name}" key rotated`);
  const fresh = db.select().from(apps).where(eq(apps.id, id)).all()[0]!;
  emitEvent({ type: 'app.updated', data: { id, name: row.name } });
  res.json({ ...publicApp(fresh), key });
});

// POST /api/apps/:id/revoke — key refused from now on; row kept for audit.
router.post('/:id/revoke', requireRole('owner', 'admin'), (req, res) => {
  const id = (req.params as { id: string }).id;
  const row = db.select().from(apps).where(eq(apps.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  db.update(apps).set({ revokedAt: Date.now() }).where(eq(apps.id, id)).run();
  emitLog(`app "${row.name}" key revoked`);
  const fresh = db.select().from(apps).where(eq(apps.id, id)).all()[0]!;
  emitEvent({ type: 'app.updated', data: { id, name: row.name } });
  res.json(publicApp(fresh));
});

// DELETE /api/apps/:id — remove entirely (access log cascades; Org page archived).
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const id = (req.params as { id: string }).id;
  const row = db.select().from(apps).where(eq(apps.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  db.delete(apps).where(eq(apps.id, id)).run();
  const ctx = getOrgContext();
  if (ctx && row.orgDbPageId) await archiveAgentPage(ctx.apiKey, row.orgDbPageId);
  emitLog(`app "${row.name}" deleted`);
  emitEvent({ type: 'app.deleted', data: { id, name: row.name } });
  res.json({ ok: true });
});

// POST /api/apps/:id/sync-notion — manual Org DB re-sync (mirrors agents).
router.post('/:id/sync-notion', requireRole('owner', 'admin'), async (req, res) => {
  const id = (req.params as { id: string }).id;
  const row = db.select().from(apps).where(eq(apps.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  const ctx = getOrgContext();
  if (!ctx) { res.status(400).json({ error: 'not_ready', message: 'Provision the Notion workspace first.' }); return; }
  try {
    const { pageId, url } = await upsertAppPage(ctx.apiKey, ctx.orgDbId,
      { name: row.name, description: row.description }, row.orgDbPageId ?? undefined);
    db.update(apps).set({ orgDbPageId: pageId }).where(eq(apps.id, id)).run();
    emitEvent({ type: 'app.updated', data: { id, name: row.name } });
    res.json({ orgDbPageId: pageId, url });
  } catch (err) {
    res.status(502).json({ error: 'sync_failed', message: err instanceof Error ? err.message : 'failed' });
  }
});

// GET /api/apps/:id/access — the recent access trail for the audit view.
router.get('/:id/access', (req, res) => {
  const id = (req.params as { id: string }).id;
  if (!db.select().from(apps).where(eq(apps.id, id)).all()[0]) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const limit = Number(req.query['limit']) || 100;
  res.json(recentAppAccess(id, limit).map(r => ({
    method: r.method, path: r.path, status: r.status, ip: r.ip, at: r.at,
  })));
});

export { router as appsRouter };
