import 'dotenv/config';
import express from 'express';
import {
  handleNotionWebhook,
  getPendingVerificationToken,
  clearPendingVerificationToken,
} from './triggers/webhook.js';
import { resolveCallback } from './queue/dispatcher.js';
import { detectStaleRuns } from './startup/stale-run-detector.js';
import { writeCheckpoint, appendComment } from './notion/client.js';

const app = express();
app.use(express.json());

// Shared secret for agent self-registration endpoints.
// Must be >= 32 chars. If not set, registration routes return 501.
function getRegistrationToken(): string | null {
  const t = process.env.NORC_REGISTRATION_TOKEN ?? '';
  return t.length >= 32 ? t : null;
}

function requireRegistrationToken(req: express.Request, res: express.Response): boolean {
  const token = getRegistrationToken();
  if (!token) {
    res.status(501).json({
      error: 'not_configured',
      message: 'NORC_REGISTRATION_TOKEN is not set or too short (minimum 32 characters)',
      hint: 'Add NORC_REGISTRATION_TOKEN=<32+ char secret> to .env and restart',
    });
    return false;
  }
  const auth = req.headers['authorization'] ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== token) {
    res.status(401).json({
      error: 'invalid_token',
      message: 'Authorization token is wrong or missing',
      hint: 'Pass the NORC_REGISTRATION_TOKEN value as: Authorization: Bearer <token>',
    });
    return false;
  }
  return true;
}

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Notion webhook ingestion (public endpoint)
app.post('/webhooks/notion', handleNotionWebhook);

// Webhook verification token polling — norc init calls this while waiting for Notion's ping
app.get('/api/init/verify-token', (_req, res) => {
  const token = getPendingVerificationToken();
  if (token) {
    clearPendingVerificationToken();
    res.json({ token });
  } else {
    res.json({ token: null });
  }
});

// Agent self-registration — requires NORC_REGISTRATION_TOKEN
app.post('/api/agents/register', async (req, res) => {
  if (!requireRegistrationToken(req, res)) return;

  const { name, adapter = 'generic', capabilities = [], contextLevel = 'project', parentAgent, workDir } = req.body;

  if (!name) {
    res.status(400).json({ error: 'missing_name', message: 'name is required', hint: 'Provide a name like "my-agent"' });
    return;
  }
  if (!AGENT_NAME_RE.test(name)) {
    res.status(400).json({
      error: 'invalid_name',
      message: `Agent name "${name}" is invalid`,
      hint: 'Use only lowercase letters, digits, hyphens, and underscores. Must start with a letter or digit.',
    });
    return;
  }

  const { appendAgent, readAgentsJson, writeAgentsJson } = await import('./cli/lib/env-file.js');
  const { createOrgDbAgentPage } = await import('./notion/client.js');
  const { invalidateCache } = await import('./notion/org-cache.js');

  // Write to Notion Org DB first so agents.json only gets written on success
  let orgDbPageId = '';
  try {
    orgDbPageId = await createOrgDbAgentPage({ name, adapter, contextLevel, capabilities });
  } catch (err: any) {
    // Non-fatal if Notion isn't configured; log and continue
    console.warn(`[register] Notion write failed for agent "${name}":`, err.message);
  }

  const registeredAt = new Date().toISOString();
  await appendAgent({
    name,
    orgDbPageId,
    adapter: adapter === 'ClaudeCodeAdapter' ? 'ClaudeCodeAdapter' : 'generic' as any,
    authEnv: '',
    timeoutMin: 30,
    contextLevel: ['task', 'project', 'strategic'].includes(contextLevel) ? contextLevel : 'project',
    parentAgent,
    registeredAt,
    capabilities,
  });

  if (orgDbPageId) await invalidateCache();

  res.status(201).json({
    registered: true,
    agentId: orgDbPageId || name,
    callbackBase: process.env.NORC_PUBLIC_URL ?? '',
    norcVersion: '1.0',
    registeredAt,
  });
});

// Invitation prompt — returns template with placeholders, never real token
app.get('/api/agents/invite', (_req, res) => {
  const norcUrl = process.env.NORC_PUBLIC_URL ?? 'https://your-norc-url';
  const prompt = `## NORC Orchestration Protocol

### BOOTSTRAP ONCE (run this on first load)

If you have not yet registered with NORC, execute:

curl -X POST ${norcUrl}/api/agents/register \\
  -H "Authorization: Bearer {YOUR_REGISTRATION_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"{YOUR_AGENT_NAME}","adapter":"generic","capabilities":[],"contextLevel":"project"}'

Replace {YOUR_AGENT_NAME} with a slug like "my-agent" (lowercase, hyphens ok).
Replace {YOUR_REGISTRATION_TOKEN} with the NORC_REGISTRATION_TOKEN value from your operator.
Wait for: {"registered":true} before proceeding.

### FOR EACH TASK containing [NORC EXECUTION CONTRACT]

1. REPORT COMPLETION: When done, POST to the callback_url from the contract:

curl -X POST <callback_url from contract> \\
  -H "Authorization: Bearer <callback_token from contract>" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done","output":"...","summary":"1-2 sentence summary"}'

Also emit this sentinel as the LAST LINE of your output (machine-parsed):
NORC_OUTPUT: {"status":"done","summary":"<summary>","next_agent":null}

2. REPORT FAILURE: POST with status="failed" and a clear reason.
   Also emit: NORC_OUTPUT: {"status":"failed","summary":"<reason>","next_agent":null}

3. DELEGATE: Set next_agent to another agent's name:
   NORC_OUTPUT: {"status":"done","summary":"<summary>","next_agent":"<agent-name>"}

4. CHECKPOINT (tasks >5 min): POST to checkpoint_url from the contract after each major step:

curl -X POST <checkpoint_url from contract> \\
  -H "Authorization: Bearer <callback_token from contract>" \\
  -H "Content-Type: application/json" \\
  -d '{"taskId":"<contextRef from contract>","completedStep":1,"summary":"step complete"}'

5. STAY IN SCOPE: Only take actions relevant to the described task.`;

  res.json({
    norcUrl,
    prompt,
    registrationPayload: {
      name: '{YOUR_AGENT_NAME}',
      adapter: 'generic',
      capabilities: [],
      contextLevel: 'project',
    },
  });
});

// Connection health check per agent
app.post('/api/agents/:name/ping', async (req, res) => {
  const agentName = decodeURIComponent(req.params.name);
  const { readAgentsJson } = await import('./cli/lib/env-file.js');

  const agents = await readAgentsJson();
  const agent = agents.find(a => a.name === agentName);

  if (!agent) {
    res.status(404).json({
      error: 'agent_not_found',
      message: `Agent "${agentName}" is not registered`,
      hint: 'Check norc agent list for registered agents',
    });
    return;
  }

  const start = Date.now();
  let version = '';
  let ok = true;

  if (agent.adapter === 'ClaudeCodeAdapter') {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);
    try {
      const { stdout } = await exec('claude', ['--version']);
      version = stdout.trim().split('\n')[0] ?? '';
    } catch {
      ok = false;
      version = 'claude CLI not found';
    }
  }

  const latencyMs = Date.now() - start;
  res.json({ ok, agentName, latencyMs, version: version || undefined });
});

// Agent callback (public endpoint)
app.post('/api/callback/:token', async (req, res) => {
  const { token } = req.params;
  const body = req.body;

  const resolved = resolveCallback(token, body);
  if (!resolved) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  res.status(200).json({ received: true });
});

// Agent checkpoint (public endpoint)
app.post('/api/checkpoint/:token', async (req, res) => {
  const { token } = req.params;
  const { taskId, summary, completedStep } = req.body;

  if (!taskId) {
    res.status(400).json({ error: 'taskId required' });
    return;
  }

  await writeCheckpoint(taskId, {
    checkpointToken: token,
    completedStep,
    summary,
    timestamp: new Date().toISOString(),
  });

  await appendComment(taskId, `Checkpoint ${completedStep}: ${summary}`);

  res.status(200).json({ received: true });
});

// Agents list — Dashboard + CLI use this
app.get('/api/agents', async (_req, res) => {
  try {
    const { readAgentsJson } = await import('./cli/lib/env-file.js');
    const { getCachedAgents } = await import('./notion/org-cache.js');
    const agentConfigs = await readAgentsJson();
    const orgAgents = await getCachedAgents().catch(() => []);

    const agents = agentConfigs.map(cfg => {
      const org = orgAgents.find(a => a.name.toLowerCase() === cfg.name.toLowerCase());
      return {
        name: cfg.name,
        adapter: cfg.adapter,
        contextLevel: cfg.contextLevel,
        timeoutMin: cfg.timeoutMin,
        parentAgent: cfg.parentAgent ?? null,
        capabilities: cfg.capabilities ?? [],
        status: org ? 'Available' : 'Offline',
        lastActive: cfg.lastDispatchAt ?? null,
        registeredAt: cfg.registeredAt ?? null,
      };
    });

    res.json(agents);
  } catch {
    res.json([]);
  }
});

// Manual run (bypass @mention — CLI uses this)
app.post('/api/run', async (req, res) => {
  const { pageId, agentName } = req.body;
  if (!pageId) {
    res.status(400).json({ error: 'pageId required' });
    return;
  }

  const { getTask } = await import('./notion/client.js');
  const { classifyEvent } = await import('./orchestrator/orchestrator-agent.js');
  const { enqueueDispatch } = await import('./queue/dispatcher.js');

  try {
    const task = await getTask(pageId);
    const agent = agentName ?? task.assignedAgent ?? 'claude-code';
    const decision = await classifyEvent({
      taskId: pageId,
      taskName: task.name,
      taskStatus: task.status,
      assignedAgent: agent,
      mentionContext: 'manual run via norc CLI',
    });
    if (decision.action === 'execute') {
      await enqueueDispatch(decision);
      res.json({ queued: true, agent });
    } else {
      res.json({ queued: false, reason: decision.anomalyReason });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Server-sent events log stream for `norc logs`
const logListeners = new Set<(line: string) => void>();

export function emitLog(line: string): void {
  process.stdout.write(line + '\n');
  for (const fn of logListeners) fn(line);
}

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const agentFilter = req.query.agent as string | undefined;

  const send = (line: string) => {
    if (agentFilter && !line.toLowerCase().includes(agentFilter.toLowerCase())) return;
    res.write(`data: ${line}\n\n`);
  };

  logListeners.add(send);
  req.on('close', () => logListeners.delete(send));
});

// Health check (includes Redis status)
app.get('/health', async (_req, res) => {
  let redisStatus = 'unknown';
  try {
    const Redis = (await import('ioredis')).default;
    const r = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const pong = await r.ping();
    redisStatus = pong === 'PONG' ? 'ok' : 'error';
    await r.quit();
  } catch {
    redisStatus = 'error';
  }
  res.json({ status: 'ok', redis: redisStatus, ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  // Validate NORC_REGISTRATION_TOKEN length at startup
  const regToken = process.env.NORC_REGISTRATION_TOKEN ?? '';
  if (regToken && regToken.length < 32) {
    console.warn('[norc] WARNING: NORC_REGISTRATION_TOKEN is set but too short (< 32 chars). Self-registration is disabled.');
  }

  // Load Notion credentials from ~/.norc/config.json before starting
  const { loadConfigIntoEnv } = await import('./cli/lib/config.js');
  await loadConfigIntoEnv();

  // On startup: detect stale runs from previous session
  console.log('[norc] checking for stale runs...');
  await detectStaleRuns().catch(err => console.error('[norc] stale run check failed:', err));

  app.listen(PORT, () => {
    console.log(`[norc] engine listening on :${PORT}`);
    console.log(`[norc] webhook: POST /webhooks/notion`);
    console.log(`[norc] callback: POST /api/callback/:token`);
    console.log(`[norc] register: POST /api/agents/register (requires NORC_REGISTRATION_TOKEN)`);
  });
}

main().catch(err => {
  console.error('[norc] fatal startup error:', err);
  process.exit(1);
});
