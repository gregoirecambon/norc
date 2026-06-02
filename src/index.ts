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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
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
