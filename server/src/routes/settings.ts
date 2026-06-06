import { Router, type Router as ExpressRouter } from 'express';
import { getNorcSettingsOrDefault, upsertNorcSettings, type NorcSettings } from '../lib/norc-settings.js';
import { testTriageConnection, type TriageProvider } from '../lib/orchestrator-agent.js';
import { testNotification } from '../lib/notifier.js';
import { emitLog } from '../lib/logger.js';

const strOrNull = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;

const router: ExpressRouter = Router();

/** Public view — never leak the orchestrator API key; report whether one is set. */
function safe(s: NorcSettings) {
  return {
    orchestratorEnabled: s.orchestratorEnabled,
    orchestratorProvider: s.orchestratorProvider,
    orchestratorApiKeySet: !!s.orchestratorApiKey,
    orchestratorBaseUrl: s.orchestratorBaseUrl,
    orchestratorModel: s.orchestratorModel,
    orchestratorSystemPrompt: s.orchestratorSystemPrompt,
    autoRouteThreshold: s.autoRouteThreshold,
    runTimeoutSec: s.runTimeoutSec,
    heartbeatEnabled: s.heartbeatEnabled,
    heartbeatIntervalSec: s.heartbeatIntervalSec,
    notifyEnabled: s.notifyEnabled,
    notifyEmail: s.notifyEmail,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    smtpUser: s.smtpUser,
    smtpPassSet: !!s.smtpPass,
    smtpFrom: s.smtpFrom,
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
  if (b['orchestratorProvider'] === 'anthropic' || b['orchestratorProvider'] === 'openai') patch['orchestratorProvider'] = b['orchestratorProvider'];
  if ('orchestratorBaseUrl' in b) patch['orchestratorBaseUrl'] = typeof b['orchestratorBaseUrl'] === 'string' && b['orchestratorBaseUrl'].trim() ? b['orchestratorBaseUrl'].trim() : null;
  if (typeof b['orchestratorModel'] === 'string' && b['orchestratorModel'].trim()) patch['orchestratorModel'] = b['orchestratorModel'].trim();
  if ('orchestratorSystemPrompt' in b) patch['orchestratorSystemPrompt'] = typeof b['orchestratorSystemPrompt'] === 'string' ? b['orchestratorSystemPrompt'] : null;
  if (typeof b['autoRouteThreshold'] === 'number') patch['autoRouteThreshold'] = Math.max(0, Math.min(1, b['autoRouteThreshold']));
  if (typeof b['runTimeoutSec'] === 'number' && b['runTimeoutSec'] >= 60) patch['runTimeoutSec'] = Math.floor(b['runTimeoutSec']);
  if (typeof b['heartbeatEnabled'] === 'boolean') patch['heartbeatEnabled'] = b['heartbeatEnabled'];
  if (typeof b['heartbeatIntervalSec'] === 'number' && b['heartbeatIntervalSec'] >= 10) patch['heartbeatIntervalSec'] = Math.floor(b['heartbeatIntervalSec']);
  if (b['orchestratorApiKey'] === null) patch['orchestratorApiKey'] = null;
  else if (typeof b['orchestratorApiKey'] === 'string' && b['orchestratorApiKey'].trim()) patch['orchestratorApiKey'] = b['orchestratorApiKey'].trim();

  // Notifications (email-in-the-loop). Empty smtpPass is ignored (keeps the stored
  // one); send null to clear. Other string fields normalize ''/whitespace to null.
  if (typeof b['notifyEnabled'] === 'boolean') patch['notifyEnabled'] = b['notifyEnabled'];
  if ('notifyEmail' in b) patch['notifyEmail'] = strOrNull(b['notifyEmail']);
  if ('smtpHost' in b) patch['smtpHost'] = strOrNull(b['smtpHost']);
  if (typeof b['smtpPort'] === 'number') patch['smtpPort'] = Math.floor(b['smtpPort']);
  else if (b['smtpPort'] === null) patch['smtpPort'] = null;
  if ('smtpUser' in b) patch['smtpUser'] = strOrNull(b['smtpUser']);
  if ('smtpFrom' in b) patch['smtpFrom'] = strOrNull(b['smtpFrom']);
  if (b['smtpPass'] === null) patch['smtpPass'] = null;
  else if (typeof b['smtpPass'] === 'string' && b['smtpPass'].trim()) patch['smtpPass'] = b['smtpPass'].trim();

  const saved = upsertNorcSettings(patch);
  emitLog(`NORC settings updated (triage ${saved.orchestratorEnabled ? 'on' : 'off'} via ${saved.orchestratorProvider}, heartbeat ${saved.heartbeatEnabled ? 'on' : 'off'})`);
  res.json(safe(saved));
});

// POST /api/settings/test — verify the triage LLM is reachable. Body may carry
// unsaved form values { provider?, apiKey?, baseUrl?, model? }; anything omitted
// falls back to the saved settings (so a blank key reuses the stored one).
router.post('/test', async (req, res) => {
  const saved = getNorcSettingsOrDefault();
  const b = req.body as Record<string, unknown>;

  const provider: TriageProvider = b['provider'] === 'openai' || b['provider'] === 'anthropic'
    ? b['provider'] : (saved.orchestratorProvider as TriageProvider);
  const baseUrl = typeof b['baseUrl'] === 'string' && b['baseUrl'].trim() ? b['baseUrl'].trim() : saved.orchestratorBaseUrl;
  const model = typeof b['model'] === 'string' && b['model'].trim() ? b['model'].trim() : saved.orchestratorModel;
  const apiKey = typeof b['apiKey'] === 'string' && b['apiKey'].trim() ? b['apiKey'].trim() : (saved.orchestratorApiKey ?? '');

  if (provider === 'openai' && !baseUrl) {
    res.status(400).json({ ok: false, error: 'A base URL is required for the OpenAI-compatible provider.' });
    return;
  }
  if (provider === 'anthropic' && !apiKey) {
    res.status(400).json({ ok: false, error: 'An API key is required for the Anthropic provider.' });
    return;
  }

  const start = Date.now();
  const result = await testTriageConnection({ provider, apiKey, baseUrl, model });
  const latencyMs = Date.now() - start;
  emitLog(`triage test (${provider}, ${model}): ${result.ok ? `OK (${latencyMs}ms)` : `FAILED — ${result.error}`}`);
  res.json({ ok: result.ok, latencyMs, sample: result.text?.slice(0, 80), error: result.error });
});

// POST /api/settings/test-notification — verify SMTP connectivity (saved config).
router.post('/test-notification', async (_req, res) => {
  const result = await testNotification();
  emitLog(`notification test: ${result.ok ? 'OK' : `FAILED — ${result.error}`}`);
  res.json(result);
});

export { router as settingsRouter };
