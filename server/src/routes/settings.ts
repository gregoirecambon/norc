import { Router, type Router as ExpressRouter } from 'express';
import { getNorcSettingsOrDefault, upsertNorcSettings, type NorcSettings } from '../lib/norc-settings.js';
import { testTriageConnection, type TriageProvider } from '../lib/orchestrator-agent.js';
import { sendTestEmail, smtpSource, type SmtpConfig } from '../lib/mailer.js';
import { requestUser } from '../lib/user-auth.js';
import { emitLog } from '../lib/logger.js';

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
    runHardCapSec: s.runHardCapSec,
    heartbeatEnabled: s.heartbeatEnabled,
    heartbeatIntervalSec: s.heartbeatIntervalSec,
    deepPingEnabled: s.deepPingEnabled,
    deepPingIntervalSec: s.deepPingIntervalSec,
    failureNotifyThreshold: s.failureNotifyThreshold,
    schedulerEnabled: s.schedulerEnabled,
    autoProposeEnabled: s.autoProposeEnabled,
    autoProposeIntervalHours: s.autoProposeIntervalHours,
    autoProposeSummaryModel: s.autoProposeSummaryModel,
    autoProposeProbeEnabled: s.autoProposeProbeEnabled,
    autoProposeProbeCooldownHours: s.autoProposeProbeCooldownHours,
    choresEnabled: s.choresEnabled,
    choresNotionSync: s.choresNotionSync,
    ceoMemoUpdatedAt: s.ceoMemoUpdatedAt,   // observability only — the memo blob is never returned here
    // Email — password hidden, like the orchestrator key.
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort ?? 587,
    smtpUser: s.smtpUser,
    smtpPassSet: !!s.smtpPass,
    smtpFrom: s.smtpFrom,
    smtpSecure: s.smtpSecure,
    smtpSource: smtpSource(),
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
  if (typeof b['runHardCapSec'] === 'number' && b['runHardCapSec'] >= 60) patch['runHardCapSec'] = Math.floor(b['runHardCapSec']);
  if (typeof b['heartbeatEnabled'] === 'boolean') patch['heartbeatEnabled'] = b['heartbeatEnabled'];
  if (typeof b['heartbeatIntervalSec'] === 'number' && b['heartbeatIntervalSec'] >= 10) patch['heartbeatIntervalSec'] = Math.floor(b['heartbeatIntervalSec']);
  if (typeof b['deepPingEnabled'] === 'boolean') patch['deepPingEnabled'] = b['deepPingEnabled'];
  if (typeof b['deepPingIntervalSec'] === 'number' && b['deepPingIntervalSec'] >= 60) patch['deepPingIntervalSec'] = Math.floor(b['deepPingIntervalSec']);
  if (typeof b['failureNotifyThreshold'] === 'number' && b['failureNotifyThreshold'] >= 1) patch['failureNotifyThreshold'] = Math.floor(b['failureNotifyThreshold']);
  if (typeof b['schedulerEnabled'] === 'boolean') patch['schedulerEnabled'] = b['schedulerEnabled'];
  if (typeof b['autoProposeEnabled'] === 'boolean') patch['autoProposeEnabled'] = b['autoProposeEnabled'];
  if (typeof b['autoProposeIntervalHours'] === 'number') patch['autoProposeIntervalHours'] = Math.max(1, Math.min(24, Math.floor(b['autoProposeIntervalHours'])));
  if ('autoProposeSummaryModel' in b) patch['autoProposeSummaryModel'] = typeof b['autoProposeSummaryModel'] === 'string' && b['autoProposeSummaryModel'].trim() ? b['autoProposeSummaryModel'].trim() : null;
  if (typeof b['autoProposeProbeEnabled'] === 'boolean') patch['autoProposeProbeEnabled'] = b['autoProposeProbeEnabled'];
  if (typeof b['autoProposeProbeCooldownHours'] === 'number' && b['autoProposeProbeCooldownHours'] >= 1) patch['autoProposeProbeCooldownHours'] = Math.floor(b['autoProposeProbeCooldownHours']);
  if (typeof b['choresEnabled'] === 'boolean') patch['choresEnabled'] = b['choresEnabled'];
  if (typeof b['choresNotionSync'] === 'boolean') patch['choresNotionSync'] = b['choresNotionSync'];
  if (b['orchestratorApiKey'] === null) patch['orchestratorApiKey'] = null;
  else if (typeof b['orchestratorApiKey'] === 'string' && b['orchestratorApiKey'].trim()) patch['orchestratorApiKey'] = b['orchestratorApiKey'].trim();

  // Email (SMTP). Empty smtpPass is ignored (saving other fields keeps the
  // stored one); send null explicitly to clear — same contract as the API key.
  if ('smtpHost' in b) patch['smtpHost'] = typeof b['smtpHost'] === 'string' && b['smtpHost'].trim() ? b['smtpHost'].trim() : null;
  if (typeof b['smtpPort'] === 'number' && b['smtpPort'] >= 1 && b['smtpPort'] <= 65535) patch['smtpPort'] = Math.floor(b['smtpPort']);
  if ('smtpUser' in b) patch['smtpUser'] = typeof b['smtpUser'] === 'string' && b['smtpUser'].trim() ? b['smtpUser'].trim() : null;
  if ('smtpFrom' in b) patch['smtpFrom'] = typeof b['smtpFrom'] === 'string' && b['smtpFrom'].trim() ? b['smtpFrom'].trim() : null;
  if (typeof b['smtpSecure'] === 'boolean') patch['smtpSecure'] = b['smtpSecure'];
  if (b['smtpPass'] === null) patch['smtpPass'] = null;
  else if (typeof b['smtpPass'] === 'string' && b['smtpPass'].trim()) patch['smtpPass'] = b['smtpPass'];

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
  emitLog(`triage test (${provider}, ${model}): ${result.ok ? `OK (${latencyMs}ms)` : `FAILED — ${result.error}`}`, 'Triage');
  res.json({ ok: result.ok, latencyMs, sample: result.text?.slice(0, 80), error: result.error });
});

// POST /api/settings/test-email — send a test message to the signed-in user.
// Body may carry unsaved form values { host?, port?, user?, pass?, from?, secure? };
// anything omitted falls back to the effective config (a blank pass reuses the
// stored one).
router.post('/test-email', async (req, res) => {
  const to = requestUser(req).email;
  const b = req.body as Record<string, unknown>;
  const saved = getNorcSettingsOrDefault();

  const override: Partial<SmtpConfig> = {};
  if (typeof b['host'] === 'string' && b['host'].trim()) override.host = b['host'].trim();
  if (typeof b['port'] === 'number') override.port = Math.floor(b['port']);
  if ('user' in b) override.user = typeof b['user'] === 'string' && b['user'].trim() ? b['user'].trim() : null;
  if ('from' in b) override.from = typeof b['from'] === 'string' && b['from'].trim() ? b['from'].trim() : null;
  if (typeof b['secure'] === 'boolean') override.secure = b['secure'];
  if (typeof b['pass'] === 'string' && b['pass'].trim()) override.pass = b['pass'];
  else if (override.host && override.host === saved.smtpHost && saved.smtpPass) override.pass = saved.smtpPass;

  const start = Date.now();
  const result = await sendTestEmail(to, override);
  const latencyMs = Date.now() - start;
  emitLog(`test email to ${to}: ${result.sent ? `sent (${latencyMs}ms)` : `FAILED — ${result.error}`}`);
  res.json({ ok: result.sent, latencyMs, to, error: result.error });
});

export { router as settingsRouter };
