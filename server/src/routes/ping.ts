import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, connectionTests } from '../db/schema.js';
import { pingAgent } from '../adapters/index.js';
import { emitLog } from '../lib/logger.js';
import type { Agent, AdapterType, AgentStatus } from '../types.js';

const router: ExpressRouter = Router({ mergeParams: true });

// POST /api/agents/:id/ping
router.post('/', async (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  let config: Record<string, unknown>;
  try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }

  const agent: Agent = {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType as AdapterType,
    adapterConfig: config,
    status: row.status as AgentStatus,
    lastPingedAt: row.lastPingedAt ?? null,
    lastLatencyMs: row.lastLatencyMs ?? null,
    registeredAt: row.registeredAt,
    metadata: {},
  };

  const result = await pingAgent(agent);
  const now = Date.now();
  const newStatus: AgentStatus = result.ok ? 'connected' : 'unreachable';

  db.update(agents).set({
    status: newStatus,
    lastPingedAt: now,
    lastLatencyMs: result.latencyMs,
  }).where(eq(agents.id, id)).run();

  db.insert(connectionTests).values({
    id: randomUUID(),
    agentId: id,
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error ?? null,
    testedAt: now,
  }).run();

  const statusEmoji = result.ok ? 'OK' : 'FAIL';
  emitLog(`agent ${row.name} ping ${statusEmoji} (${result.latencyMs}ms)${result.error ? ` — ${result.error}` : ''}`);

  res.json({ ok: result.ok, latencyMs: result.latencyMs, agentId: id, testedAt: now, error: result.error });
});

export { router as pingRouter };
