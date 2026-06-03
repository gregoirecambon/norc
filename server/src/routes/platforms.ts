import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { platforms, agentPlatformGrants, agents } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { zodMiddleware } from '../lib/validate.js';

const router: ExpressRouter = Router();

// GET /api/platforms — list all (redact apiKey)
router.get('/', (_req, res) => {
  const rows = db.select().from(platforms).all();
  const grants = db.select().from(agentPlatformGrants).all();
  res.json(rows.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    hasApiKey: p.apiKey.length > 0,
    createdAt: p.createdAt,
    grantedAgentIds: grants.filter(g => g.platformId === p.id).map(g => g.agentId),
  })));
});

const PlatformSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  apiKey: z.string().min(1),
});

// POST /api/platforms — create
router.post('/', zodMiddleware(PlatformSchema), (req, res) => {
  const { name, description, apiKey } = req.body as z.infer<typeof PlatformSchema>;
  const existing = db.select().from(platforms).where(eq(platforms.name, name)).all();
  if (existing.length > 0) {
    res.status(409).json({ error: 'name_taken', message: `Platform "${name}" already exists` });
    return;
  }
  const id = randomUUID();
  const now = Date.now();
  db.insert(platforms).values({ id, name, description: description ?? null, apiKey, createdAt: now }).run();
  emitLog(`platform "${name}" created`);
  res.status(201).json({ id, name, description: description ?? null, createdAt: now });
});

// DELETE /api/platforms/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const row = db.select().from(platforms).where(eq(platforms.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  db.delete(platforms).where(eq(platforms.id, id)).run();
  emitLog(`platform "${row.name}" deleted`);
  res.json({ deleted: true });
});

// POST /api/platforms/:id/grant/:agentId — approve agent access
router.post('/:id/grant/:agentId', (req, res) => {
  const { id: platformId, agentId } = req.params;
  const platform = db.select().from(platforms).where(eq(platforms.id, platformId)).all()[0];
  if (!platform) { res.status(404).json({ error: 'platform_not_found' }); return; }
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!agent) { res.status(404).json({ error: 'agent_not_found' }); return; }

  const existing = db.select().from(agentPlatformGrants)
    .where(eq(agentPlatformGrants.agentId, agentId))
    .all()
    .find(g => g.platformId === platformId);
  if (existing) { res.json({ granted: true, already: true }); return; }

  db.insert(agentPlatformGrants).values({
    id: randomUUID(),
    agentId,
    platformId,
    grantedAt: Date.now(),
  }).run();
  emitLog(`agent "${agent.name}" granted access to platform "${platform.name}"`);
  res.json({ granted: true });
});

// DELETE /api/platforms/:id/grant/:agentId — revoke agent access
router.delete('/:id/grant/:agentId', (req, res) => {
  const { id: platformId, agentId } = req.params;
  const grant = db.select().from(agentPlatformGrants)
    .where(eq(agentPlatformGrants.agentId, agentId))
    .all()
    .find(g => g.platformId === platformId);
  if (!grant) { res.status(404).json({ error: 'grant_not_found' }); return; }
  db.delete(agentPlatformGrants).where(eq(agentPlatformGrants.id, grant.id)).run();
  res.json({ revoked: true });
});

export { router as platformsRouter };
