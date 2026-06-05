import { Router, type Router as ExpressRouter } from 'express';
import { getNorcSettingsOrDefault, upsertNorcSettings, type NorcSettings } from '../lib/norc-settings.js';
import { emitLog } from '../lib/logger.js';

const router: ExpressRouter = Router();

/** Public view — never leak the orchestrator API key; report whether one is set. */
function safe(s: NorcSettings) {
  return {
    orchestratorEnabled: s.orchestratorEnabled,
    orchestratorApiKeySet: !!s.orchestratorApiKey,
    orchestratorModel: s.orchestratorModel,
    orchestratorSystemPrompt: s.orchestratorSystemPrompt,
    autoRouteThreshold: s.autoRouteThreshold,
    heartbeatEnabled: s.heartbeatEnabled,
    heartbeatIntervalSec: s.heartbeatIntervalSec,
    updatedAt: s.updatedAt,
  };
}

// GET /api/settings
router.get('/', (_req, res) => {
  res.json(safe(getNorcSettingsOrDefault()));
});

// POST /api/settings — partial update. Empty orchestratorApiKey is ignored (so
// saving other fields doesn't wipe the key); send null explicitly to clear it.
router.post('/', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (typeof b['orchestratorEnabled'] === 'boolean') patch['orchestratorEnabled'] = b['orchestratorEnabled'];
  if (typeof b['orchestratorModel'] === 'string' && b['orchestratorModel'].trim()) patch['orchestratorModel'] = b['orchestratorModel'].trim();
  if ('orchestratorSystemPrompt' in b) patch['orchestratorSystemPrompt'] = typeof b['orchestratorSystemPrompt'] === 'string' ? b['orchestratorSystemPrompt'] : null;
  if (typeof b['autoRouteThreshold'] === 'number') patch['autoRouteThreshold'] = Math.max(0, Math.min(1, b['autoRouteThreshold']));
  if (typeof b['heartbeatEnabled'] === 'boolean') patch['heartbeatEnabled'] = b['heartbeatEnabled'];
  if (typeof b['heartbeatIntervalSec'] === 'number' && b['heartbeatIntervalSec'] >= 10) patch['heartbeatIntervalSec'] = Math.floor(b['heartbeatIntervalSec']);
  if (b['orchestratorApiKey'] === null) patch['orchestratorApiKey'] = null;
  else if (typeof b['orchestratorApiKey'] === 'string' && b['orchestratorApiKey'].trim()) patch['orchestratorApiKey'] = b['orchestratorApiKey'].trim();

  const saved = upsertNorcSettings(patch);
  emitLog(`NORC settings updated (orchestrator ${saved.orchestratorEnabled ? 'on' : 'off'}, heartbeat ${saved.heartbeatEnabled ? 'on' : 'off'})`);
  res.json(safe(saved));
});

export { router as settingsRouter };
