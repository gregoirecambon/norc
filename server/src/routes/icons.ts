// Public agent-avatar endpoint — the icon_url Slack is given on customized
// posts. Mounted OUTSIDE the /api auth guard: Slack's image fetchers carry no
// credentials. Exposes nothing but the agent's Notion page icon, keyed by an
// unguessable agent UUID.

import { Router, type Router as ExpressRouter } from 'express';
import { resolveAgentIconSource } from '../lib/slack-agents.js';

const router: ExpressRouter = Router();

const bytesCache = new Map<string, { body: Buffer; type: string; at: number }>();
const BYTES_TTL_MS = 10 * 60_000;
const MAX_ICON_BYTES = 2 * 1024 * 1024;

// GET /icons/agents/:agentId.png
router.get('/agents/:file', async (req, res) => {
  const agentId = String(req.params['file'] ?? '').replace(/\.png$/i, '');
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) { res.status(404).end(); return; }

  const hit = bytesCache.get(agentId);
  if (hit && Date.now() - hit.at < BYTES_TTL_MS) {
    res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=300').send(hit.body);
    return;
  }

  const source = await resolveAgentIconSource(agentId);
  if (!source) { res.status(404).end(); return; }
  try {
    const upstream = await fetch(source, { signal: AbortSignal.timeout(10_000) });
    const type = upstream.headers.get('content-type') ?? 'image/png';
    if (!upstream.ok || !type.startsWith('image/')) { res.status(404).end(); return; }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length === 0 || body.length > MAX_ICON_BYTES) { res.status(404).end(); return; }
    bytesCache.set(agentId, { body, type, at: Date.now() });
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=300').send(body);
  } catch {
    res.status(404).end();
  }
});

export { router as iconsRouter };
