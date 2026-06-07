import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, handshakes } from '../db/schema.js';
import { sendHandshakeChallenge } from '../adapters/challenge.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';
import type { Agent, AdapterType, AgentStatus } from '../types.js';

const router: ExpressRouter = Router({ mergeParams: true });

// POST /api/agents/:id/handshake — start handshake
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

  const handshakeId = randomUUID();
  const nonce = randomBytes(16).toString('hex');
  const now = Date.now();
  const norcUrl = process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;
  const callbackUrl = `${norcUrl}/api/handshakes/${handshakeId}/complete`;

  db.insert(handshakes).values({
    id: handshakeId,
    agentId: id,
    nonce,
    status: 'pending',
    createdAt: now,
  }).run();

  emitLog(`handshake started for agent "${row.name}" (id: ${handshakeId})`, row.name);

  sendHandshakeChallenge(agent, handshakeId, nonce, callbackUrl).catch(err => {
    const error = err instanceof Error ? err.message : 'Failed to send challenge';
    emitLog(`handshake challenge failed for agent "${row.name}": ${error}`, row.name);
    db.update(handshakes).set({ status: 'timed_out', error, completedAt: Date.now() })
      .where(eq(handshakes.id, handshakeId)).run();
    emitEvent({ type: 'handshake.updated', data: { handshakeId, agentId: id, status: 'timed_out', latencyMs: null, error } });
  });

  res.json({ handshakeId, status: 'pending', agentId: id, createdAt: now });
});

// GET /api/agents/:id/handshake/:hid — poll status
router.get('/:hid', (req, res) => {
  const { hid } = req.params as { hid: string };
  const row = db.select().from(handshakes).where(eq(handshakes.id, hid)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({
    handshakeId: row.id,
    agentId: row.agentId,
    status: row.status,
    latencyMs: row.latencyMs,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  });
});

export { router as handshakesRouter };

// POST /api/handshakes/:hid/complete — agent calls this
export function makeCompletionRouter(): ExpressRouter {
  const r: ExpressRouter = Router({ mergeParams: true });

  r.post('/:hid/complete', (req, res) => {
    const { hid } = req.params as { hid: string };
    const row = db.select().from(handshakes).where(eq(handshakes.id, hid)).all()[0];
    if (!row) { res.status(404).json({ error: 'not_found' }); return; }
    if (row.status !== 'pending') {
      res.status(409).json({ error: 'already_resolved', status: row.status });
      return;
    }

    const { nonce } = req.body as { nonce?: string };
    if (!nonce || nonce !== row.nonce) {
      res.status(401).json({ error: 'invalid_nonce' });
      return;
    }

    const now = Date.now();
    const latencyMs = now - row.createdAt;
    db.update(handshakes).set({ status: 'completed', completedAt: now, latencyMs })
      .where(eq(handshakes.id, hid)).run();

    db.update(agents).set({ status: 'connected', lastPingedAt: now, lastLatencyMs: latencyMs })
      .where(eq(agents.id, row.agentId)).run();

    const agentName = db.select().from(agents).where(eq(agents.id, row.agentId)).all()[0]?.name;
    emitLog(`handshake completed by agent (id: ${hid}, latency: ${latencyMs}ms)`, agentName ?? 'NORC');
    emitEvent({ type: 'handshake.updated', data: { handshakeId: hid, agentId: row.agentId, status: 'completed', latencyMs, error: null } });

    res.json({ ok: true, latencyMs });
  });

  return r;
}
