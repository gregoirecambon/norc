// Public agent-avatar endpoint — the icon_url Slack is given on customized
// posts, and the <img> source for the dashboard. Mounted OUTSIDE the /api
// auth guard: Slack's image fetchers carry no credentials. Exposes nothing
// but the agent's Notion page icon, keyed by an unguessable agent UUID.

import { Router, type Router as ExpressRouter } from 'express';
import { storedAvatar, refreshAgentAvatar } from '../lib/agent-avatar.js';

const router: ExpressRouter = Router();

const STALE_AFTER_MS = 6 * 3600_000;
const refreshing = new Set<string>();

// GET /icons/agents/:agentId.png
router.get('/agents/:file', async (req, res) => {
  const agentId = String(req.params['file'] ?? '').replace(/\.png$/i, '');
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) { res.status(404).end(); return; }

  // Serve the mirrored avatar; fetch-and-store on first miss. A stale copy is
  // served immediately and refreshed in the background (Notion icon changes
  // also land on the next sync click).
  let avatar = storedAvatar(agentId);
  if (!avatar) {
    await refreshAgentAvatar(agentId).catch(() => ({ hasAvatar: false }));
    avatar = storedAvatar(agentId);
  } else if ((avatar.at ?? 0) < Date.now() - STALE_AFTER_MS && !refreshing.has(agentId)) {
    refreshing.add(agentId);
    void refreshAgentAvatar(agentId).catch(() => undefined).finally(() => refreshing.delete(agentId));
  }
  if (!avatar) { res.status(404).end(); return; }
  res.set('Content-Type', avatar.type).set('Cache-Control', 'public, max-age=300').send(avatar.body);
});

export { router as iconsRouter };
