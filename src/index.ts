import 'dotenv/config';
import express from 'express';
import { handleNotionWebhook } from './triggers/webhook.js';
import { resolveCallback } from './queue/dispatcher.js';
import { detectStaleRuns } from './startup/stale-run-detector.js';
import { writeCheckpoint, appendComment } from './notion/client.js';

const app = express();
app.use(express.json());

// Notion webhook ingestion (public endpoint)
app.post('/webhooks/notion', handleNotionWebhook);

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
      const org = orgAgents.find(a => a.name.toLowerCase().includes(cfg.name.toLowerCase()));
      return {
        name: cfg.name,
        adapter: cfg.adapter,
        contextLevel: cfg.contextLevel,
        timeoutMin: cfg.timeoutMin,
        status: org ? 'Available' : 'Offline',
        lastActive: null,
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
    r.disconnect();
  } catch {
    redisStatus = 'error';
  }
  res.json({ status: 'ok', redis: redisStatus, ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  // On startup: detect stale runs from previous session
  console.log('[norc] checking for stale runs...');
  await detectStaleRuns().catch(err => console.error('[norc] stale run check failed:', err));

  app.listen(PORT, () => {
    console.log(`[norc] engine listening on :${PORT}`);
    console.log(`[norc] webhook: POST /webhooks/notion`);
    console.log(`[norc] callback: POST /api/callback/:token`);
  });
}

main().catch(err => {
  console.error('[norc] fatal startup error:', err);
  process.exit(1);
});
