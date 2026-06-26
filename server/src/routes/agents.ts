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
import { notifySkillUpdate, requestWorkerUninstall } from '../adapters/index.js';
import { getOrgContext, upsertAgentPage, archiveAgentPage } from '../lib/notion-orgdb.js';
import { NORC_SKILL_VERSION } from '../lib/skill.js';
import { pendingItems } from '../lib/dispatch-queue.js';
import { drainAgent } from '../lib/orchestrator.js';
import { setTaskStatus } from '../lib/notion-writeback.js';
import { notionIntegration } from '../db/schema.js';
import { norcBaseUrl } from '../lib/base-url.js';
import { isSlackActive } from '../lib/slack-integration.js';
import { ensureAgentUsergroup, disableAgentUsergroup } from '../lib/slack-agents.js';
import { refreshAgentAvatar } from '../lib/agent-avatar.js';
import type { AdapterType } from '../types.js';

const router: ExpressRouter = Router();

/**
 * Push an agent to the Notion Org DB if the workspace is provisioned.
 * Best-effort: never throws, never blocks the caller.
 */
async function syncAgentBestEffort(agent: { id: string; name: string; adapterType: string; status: string; orgDbPageId: string | null; kind?: string }): Promise<void> {
  const ctx = getOrgContext();
  if (!ctx) return;
  try {
    const { pageId } = await upsertAgentPage(ctx.apiKey, ctx.orgDbId, agent, agent.orgDbPageId ?? undefined);
    db.update(agents).set({ orgDbPageId: pageId }).where(eq(agents.id, agent.id)).run();
    void refreshAgentAvatar(agent.id).catch(() => undefined);
    emitEvent({ type: 'agent.updated', data: { id: agent.id, orgDbPageId: pageId } });
  } catch (err) {
    emitLog(`agent ${agent.name} Notion sync failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

// Vendored inside the server package (server/skills/…) so it ships in the Docker
// image. '../../skills/…' resolves the same from src/routes (dev) and dist/routes.
const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills/connect/SKILL.md',
);

const SECRET_FIELDS = new Set(['apiKey', 'authToken', 'token', 'password', 'secret', 'sharedSecret', 'wsPrivateKey', 'wsPublicKey']);

function redactConfig(raw: string): Record<string, unknown> {
  let config: Record<string, unknown>;
  try { config = JSON.parse(raw); } catch {
    console.warn('redactConfig: malformed adapterConfig JSON — returning empty config');
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_FIELDS.has(k) && typeof v === 'string' && v.length > 0 ? '[set]' : v;
  }
  return out;
}

function parseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/** Dashboard-relative avatar URL; ?v busts the browser cache after a re-sync. */
function agentAvatarUrl(id: string, hasAvatar: boolean): string | null {
  return hasAvatar ? `/icons/agents/${id}.png?v=${Date.now()}` : null;
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
    orgDbPageId: r.orgDbPageId ?? null,
    maxConcurrentRuns: r.maxConcurrentRuns,
    slackEnabled: r.slackEnabled,
    slackHandle: r.slackHandle ?? null,
    avatarUrl: r.avatar ? `/icons/agents/${r.id}.png?v=${r.avatarAt ?? 0}` : null,
  })));
});

// PATCH /api/agents/:id/limits — dispatch capacity (how many work runs at once).
const LimitsSchema = z.object({ maxConcurrentRuns: z.number().int().min(1).max(20) });
router.patch('/:id/limits', zodMiddleware(LimitsSchema), (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  const { maxConcurrentRuns } = req.body as z.infer<typeof LimitsSchema>;
  db.update(agents).set({ maxConcurrentRuns }).where(eq(agents.id, id)).run();
  emitLog(`agent ${row.name} max concurrent runs → ${maxConcurrentRuns}`);
  emitEvent({ type: 'agent.updated', data: { id, maxConcurrentRuns } });
  // A raised cap may free queued work right away.
  setImmediate(() => void drainAgent(id).catch(err =>
    emitLog(`queue drain error for agent ${id}: ${err instanceof Error ? err.message : 'unknown'}`)));
  res.json({ updated: true, maxConcurrentRuns });
});

// PATCH /api/agents/:id/slack — toggle whether this agent is reachable from
// Slack. On: provision/re-enable its @handle user group (best-effort — a paid-
// plan failure still enables the agent, with the "@Norc <name>" fallback).
// Off: disable the user group, keep the mapping for re-enable.
const SlackToggleSchema = z.object({ enabled: z.boolean() });
router.patch('/:id/slack', zodMiddleware(SlackToggleSchema), async (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  const { enabled } = req.body as z.infer<typeof SlackToggleSchema>;
  if (enabled && !isSlackActive()) {
    res.status(400).json({ error: 'slack_not_active', message: 'Connect Slack in Settings first.' });
    return;
  }

  db.update(agents).set({ slackEnabled: enabled }).where(eq(agents.id, id)).run();

  let handle: string | null = row.slackHandle;
  let warning: string | undefined;
  if (enabled) {
    const result = await ensureAgentUsergroup(id);
    handle = result.handle;
    warning = result.warning;
  } else {
    await disableAgentUsergroup(id);
  }

  emitLog(`agent ${row.name} Slack ${enabled ? 'enabled' : 'disabled'}${handle ? ` (@${handle})` : ''}`, 'Slack');
  emitEvent({ type: 'agent.updated', data: { id, slackEnabled: enabled, slackHandle: handle } });
  res.json({ enabled, handle, ...(warning ? { warning } : {}) });
});

// GET /api/agents/invite
router.get('/invite', async (_req, res) => {
  const token = await ensureActiveToken();
  const norcUrl = norcBaseUrl();

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

// POST /api/agents/:id/update-skills — tell the agent to re-download its NORC skill.
router.post('/:id/update-skills', async (req, res) => {
  const { id } = req.params as { id: string };
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  const norcUrl = norcBaseUrl();
  const skillUrl = `${norcUrl}/api/skill`;
  let config: Record<string, unknown>;
  try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }

  try {
    const result = await notifySkillUpdate(
      { name: row.name, adapterType: row.adapterType as AdapterType, adapterConfig: config },
      skillUrl,
      NORC_SKILL_VERSION,
    );
    emitLog(`update-skills "${row.name}" (${row.adapterType}): ${result.pushed ? `pushed v${NORC_SKILL_VERSION}` : `not pushed — ${result.reason}`}`);
    res.json({ ...result, version: NORC_SKILL_VERSION, skillUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed';
    emitLog(`update-skills "${row.name}" failed: ${message}`);
    res.status(502).json({ pushed: false, error: 'push_failed', message });
  }
});

const ADAPTER_TYPES = ['openclaw', 'claude-api', 'http', 'claude-local', 'codex-local'] as const;

const AgentBodySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, hyphens, underscores only'),
  adapterType: z.enum(ADAPTER_TYPES),
  adapterConfig: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
});

const RegisterSchema = AgentBodySchema;

// POST /api/agents/create — dashboard manual creation (no external token required)
router.post('/create', zodMiddleware(AgentBodySchema), (req, res) => {
  const { name, adapterType, metadata } = req.body as z.infer<typeof AgentBodySchema>;
  let { adapterConfig } = req.body as z.infer<typeof AgentBodySchema>;

  const existing = db.select().from(agents).where(eq(agents.name, name)).all();
  if (existing.length > 0) {
    res.status(409).json({ error: 'name_taken', message: `Agent "${name}" is already registered` });
    return;
  }

  let generatedAuthToken: string | undefined;
  if (adapterType === 'openclaw' && !adapterConfig['authToken']) {
    generatedAuthToken = randomBytes(24).toString('hex');
    adapterConfig = { ...adapterConfig, authToken: generatedAuthToken };
  }

  const id = randomUUID();
  const agentSecret = randomBytes(32).toString('hex');
  const now = Date.now();
  db.insert(agents).values({
    id, name,
    adapterType: adapterType as AdapterType,
    adapterConfig: JSON.stringify(adapterConfig),
    agentSecret,
    status: 'untested',
    registeredAt: now,
    metadata: JSON.stringify(metadata),
  }).run();

  const agentRow = {
    id, name, adapterType,
    adapterConfig: redactConfig(JSON.stringify(adapterConfig)),
    status: 'untested' as const,
    lastPingedAt: null, lastLatencyMs: null, registeredAt: now, metadata,
    orgDbPageId: null,
  };
  emitLog(`agent ${name} created via dashboard (adapter: ${adapterType})`);
  emitEvent({ type: 'agent.registered', data: agentRow });
  void syncAgentBestEffort({ id, name, adapterType, status: 'untested', orgDbPageId: null, kind: typeof metadata['kind'] === 'string' ? metadata['kind'] : undefined });
  res.status(201).json({ ...agentRow, ...(generatedAuthToken ? { authToken: generatedAuthToken } : {}) });
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
    orgDbPageId: null,
  };
  emitLog(`agent ${name} registered (adapter: ${adapterType})`);
  emitEvent({ type: 'agent.registered', data: agentRow });
  void syncAgentBestEffort({ id, name, adapterType, status: 'untested', orgDbPageId: null, kind: typeof metadata['kind'] === 'string' ? metadata['kind'] : undefined });
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

// POST /api/agents/:id/sync-notion — manual (re)sync to the Org DB
router.post('/:id/sync-notion', async (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  const ctx = getOrgContext();
  if (!ctx) {
    res.status(400).json({ error: 'not_ready', message: 'Provision the Notion workspace first.' });
    return;
  }

  try {
    const meta = parseJson(row.metadata);
    const { pageId, url } = await upsertAgentPage(
      ctx.apiKey, ctx.orgDbId,
      { name: row.name, adapterType: row.adapterType, status: row.status, kind: typeof meta['kind'] === 'string' ? meta['kind'] : undefined },
      row.orgDbPageId ?? undefined,
    );
    db.update(agents).set({ orgDbPageId: pageId }).where(eq(agents.id, id)).run();
    // Mirror the page icon while we're here, so Slack + the dashboard have it.
    const { hasAvatar } = await refreshAgentAvatar(id);
    emitLog(`agent ${row.name} synced to Notion Org DB${hasAvatar ? ' (avatar saved)' : ''}`);
    emitEvent({ type: 'agent.updated', data: { id, orgDbPageId: pageId } });
    res.json({ orgDbPageId: pageId, url, avatarUrl: agentAvatarUrl(id, hasAvatar) });
  } catch (err) {
    res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'Notion API error' });
  }
});

// POST /api/agents/:id/uninstall — push a teardown to a remote Claude Code worker so
// it stops+disables its service and deletes its files. Best-effort: the dashboard then
// removes the agent from NORC (DELETE) regardless. Does NOT delete the agent here.
router.post('/:id/uninstall', async (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }
  let config: Record<string, unknown>;
  try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }
  const result = await requestWorkerUninstall({ adapterType: row.adapterType as AdapterType, adapterConfig: config });
  emitLog(`uninstall pushed to "${row.name}": ${result.pushed ? 'accepted' : `failed — ${result.reason}`}`);
  res.json(result);
});

// DELETE /api/agents/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const row = db.select().from(agents).where(eq(agents.id, id)).all()[0];
  if (!row) { res.status(404).json({ error: 'not_found' }); return; }

  if (row.orgDbPageId) {
    const ctx = getOrgContext();
    if (ctx) await archiveAgentPage(ctx.apiKey, row.orgDbPageId);
  }

  // Queued work dies with the agent (FK cascade) — first put the tasks back to
  // Backlog so they're human-visible (and re-triageable) instead of stuck Queued.
  const queued = pendingItems(id);
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (queued.length > 0 && integration?.status === 'active') {
    for (const item of queued) {
      if (!item.taskPageId) continue;
      try { await setTaskStatus(integration.apiKey, item.taskPageId, 'Backlog'); } catch { /* best-effort */ }
    }
    emitLog(`agent ${row.name} had ${queued.length} queued item(s) — tasks reverted to Backlog`);
  }

  db.delete(agents).where(eq(agents.id, id)).run();
  if (queued.length > 0) emitEvent({ type: 'queue.updated', data: { agentId: id, pending: 0 } });
  emitLog(`agent ${row.name} deleted`);
  emitEvent({ type: 'agent.deleted', data: { id } });
  res.json({ deleted: true });
});

export { router as agentsRouter };
