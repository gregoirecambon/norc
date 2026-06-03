import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agents, registrationTokens } from '../db/schema.js';
import { consumeToken, ensureActiveToken } from '../lib/tokens.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';
import { zodMiddleware } from '../lib/validate.js';
import { generateWsKeypair, initiateWsPairing } from '../adapters/openclaw.js';
import type { AdapterType } from '../types.js';

const router: ExpressRouter = Router();

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'skills/connect/SKILL.md',
);

const SECRET_FIELDS = new Set(['apiKey', 'authToken', 'token', 'password', 'secret', 'wsPrivateKey', 'wsPublicKey']);

function redactConfig(raw: string): Record<string, unknown> {
  let config: Record<string, unknown>;
  try { config = JSON.parse(raw); } catch { return {}; }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_FIELDS.has(k) && typeof v === 'string' && v.length > 0 ? '[set]' : v;
  }
  return out;
}

function parseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// GET /api/agents
router.get('/', (_req, res) => {
  const rows = db.select().from(agents).all();
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    adapterType: r.adapterType,
    adapterConfig: redactConfig(r.adapterConfig),
    status: r.status,
    lastPingedAt: r.lastPingedAt ?? null,
    lastLatencyMs: r.lastLatencyMs ?? null,
    registeredAt: r.registeredAt,
    metadata: parseJson(r.metadata),
  })));
});

// GET /api/agents/invite
router.get('/invite', async (_req, res) => {
  const token = await ensureActiveToken();
  const norcUrl = process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;

  let prompt = '';
  try {
    prompt = readFileSync(SKILL_PATH, 'utf8')
      .replace(/{{NORC_URL}}/g, norcUrl)
      .replace(/{{TOKEN}}/g, token);
  } catch {
    prompt = `Register with: POST ${norcUrl}/api/agents/register (Bearer ${token})`;
  }

  res.json({ token, norcUrl, prompt });
});

const RegisterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, hyphens, underscores only'),
  adapterType: z.enum(['openclaw', 'claude-api', 'http']),
  adapterConfig: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
});

// POST /api/agents/register
router.post('/register', zodMiddleware(RegisterSchema), (req, res) => {
  const auth = (req.headers['authorization'] ?? '').toString();
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!provided) {
    res.status(401).json({ error: 'missing_token', hint: 'Pass Authorization: Bearer <token>' });
    return;
  }

  const { name, adapterType, metadata } = req.body as z.infer<typeof RegisterSchema>;
  let { adapterConfig } = req.body as z.infer<typeof RegisterSchema>;

  const existing = db.select().from(agents).where(eq(agents.name, name)).all();
  if (existing.length > 0) {
    res.status(409).json({ error: 'name_taken', message: `Agent "${name}" is already registered` });
    return;
  }

  const consumed = consumeToken(provided, name);
  if (!consumed) {
    res.status(401).json({ error: 'invalid_token', hint: 'Token is invalid or already used. Get a fresh invite from the dashboard.' });
    return;
  }

  // Auto-generate authToken for OpenClaw agents if not provided
  let generatedAuthToken: string | undefined;
  if (adapterType === 'openclaw' && !adapterConfig['authToken']) {
    generatedAuthToken = randomBytes(24).toString('hex');
    adapterConfig = { ...adapterConfig, authToken: generatedAuthToken };
  }

  const id = randomUUID();
  const agentSecret = randomBytes(32).toString('hex');
  const now = Date.now();
  db.insert(agents).values({
    id,
    name,
    adapterType: adapterType as AdapterType,
    adapterConfig: JSON.stringify(adapterConfig),
    agentSecret,
    status: 'untested',
    registeredAt: now,
    metadata: JSON.stringify(metadata),
  }).run();

  const agentRow = {
    id,
    name,
    adapterType,
    adapterConfig: redactConfig(JSON.stringify(adapterConfig)),
    status: 'untested' as const,
    lastPingedAt: null,
    lastLatencyMs: null,
    registeredAt: now,
    metadata,
  };
  emitLog(`agent ${name} registered (adapter: ${adapterType})`);
  emitEvent({ type: 'agent.registered', data: agentRow });
  res.status(201).json({
    registered: true,
    agentId: id,
    agentSecret,
    registeredAt: new Date(now).toISOString(),
    ...(generatedAuthToken ? { authToken: generatedAuthToken } : {}),
  });
});

// PATCH /api/agents/:id/config
router.patch('/:id/config', (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  const updates = req.body as Record<string, unknown>;
  if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
    res.status(400).json({ error: 'body must be a JSON object of config fields' }); return;
  }

  let existing: Record<string, unknown>;
  try { existing = JSON.parse(row.adapterConfig); } catch { existing = {}; }

  // Merge: omit keys explicitly set to null (delete semantics), keep the rest
  const merged = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete merged[k]; else merged[k] = v;
  }

  db.update(agents).set({ adapterConfig: JSON.stringify(merged) }).where(eq(agents.id, id)).run();
  emitLog(`agent ${row.name} config updated`);
  emitEvent({ type: 'agent.updated', data: { id, adapterConfig: redactConfig(JSON.stringify(merged)) } });
  res.json({ updated: true, adapterConfig: redactConfig(JSON.stringify(merged)) });
});

// POST /api/agents/:id/ws-pair — generate keypair + initiate WebSocket node pairing
router.post('/:id/ws-pair', async (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  if (row.adapterType !== 'openclaw') {
    res.status(400).json({ error: 'ws_pair only available for openclaw adapter' }); return;
  }

  let config: Record<string, unknown>;
  try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }

  // Generate keypair if not already present
  let needsKeypairSave = false;
  if (!config['wsPrivateKey'] || !config['wsPublicKey'] || !config['wsDeviceId']) {
    const keypair = generateWsKeypair();
    config = { ...config, wsPrivateKey: keypair.privateKeyPem, wsPublicKey: keypair.publicKeyB64, wsDeviceId: keypair.deviceId };
    needsKeypairSave = true;
  }

  if (needsKeypairSave) {
    db.update(agents).set({ adapterConfig: JSON.stringify(config) }).where(eq(agents.id, id)).run();
    emitLog(`agent ${row.name} WebSocket keypair generated (deviceId: ${config['wsDeviceId']})`);
    emitEvent({ type: 'agent.updated', data: { id, adapterConfig: redactConfig(JSON.stringify(config)) } });
  }

  // Attempt to connect as node — this creates a pairing request in OpenClaw
  const result = await initiateWsPairing(config, row.name);

  if (result.status === 'paired' || result.status === 'pending') {
    // Update wsPairingPending flag
    const newConfig = { ...config, wsPairingPending: result.status === 'pending' };
    db.update(agents).set({ adapterConfig: JSON.stringify(newConfig) }).where(eq(agents.id, id)).run();
    emitLog(`agent ${row.name} WebSocket pairing ${result.status} (deviceId: ${config['wsDeviceId']})`);
    emitEvent({ type: 'agent.updated', data: { id, adapterConfig: redactConfig(JSON.stringify(newConfig)) } });
    res.json({ status: result.status, deviceId: config['wsDeviceId'] });
  } else {
    res.status(502).json({ status: 'failed', error: result.error });
  }
});

// POST /api/agents/:id/ws-pair/verify — re-check pairing status after user approves in OpenClaw
router.post('/:id/ws-pair/verify', async (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  let config: Record<string, unknown>;
  try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }

  if (!config['wsPrivateKey']) {
    res.status(400).json({ error: 'No keypair — call ws-pair first' }); return;
  }

  const result = await initiateWsPairing(config, row.name);
  if (result.status !== 'failed') {
    const newConfig = { ...config, wsPairingPending: result.status === 'pending' };
    db.update(agents).set({ adapterConfig: JSON.stringify(newConfig) }).where(eq(agents.id, id)).run();
    emitEvent({ type: 'agent.updated', data: { id, adapterConfig: redactConfig(JSON.stringify(newConfig)) } });
  }
  res.json({ status: result.status, ...(result.status === 'failed' ? { error: result.error } : {}) });
});

// DELETE /api/agents/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  db.delete(agents).where(eq(agents.id, id)).run();
  emitLog(`agent ${row.name} deleted`);
  emitEvent({ type: 'agent.deleted', data: { id } });
  res.json({ deleted: true });
});

export { router as agentsRouter };
