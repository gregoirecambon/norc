import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Load from monorepo root, override any shell-set values so .env is always authoritative
dotenvConfig({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', '.env'), override: true });
import express from 'express';
import cors from 'cors';
import { lt, eq } from 'drizzle-orm';
import { runMigrations } from './db/client.js';
import { db } from './db/client.js';
import { handshakes } from './db/schema.js';
import { ensureActiveToken } from './lib/tokens.js';
import { emitLog } from './lib/logger.js';
import { emitEvent } from './lib/events.js';
import { agentsRouter } from './routes/agents.js';
import { pingRouter } from './routes/ping.js';
import { logsRouter } from './routes/logs.js';
import { eventsRouter } from './routes/events.js';
import { platformsRouter } from './routes/platforms.js';
import { meRouter } from './routes/me.js';
import { handshakesRouter, makeCompletionRouter } from './routes/handshakes.js';

const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    dbPath: process.env['DATABASE_PATH'] ?? './norc.db',
    ts: new Date().toISOString(),
  });
});

// Routes
app.use('/api/agents', agentsRouter);
app.use('/api/agents/:id/ping', pingRouter);
app.use('/api/agents/:id/handshake', handshakesRouter);
app.use('/api/handshakes', makeCompletionRouter());
app.use('/api/logs', logsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/platforms', platformsRouter);
app.use('/api/me', meRouter);

// Expire stale pending handshakes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  const stale = db.select().from(handshakes)
    .where(lt(handshakes.createdAt, cutoff))
    .all()
    .filter(h => h.status === 'pending');
  for (const h of stale) {
    db.update(handshakes).set({ status: 'timed_out', completedAt: Date.now() })
      .where(eq(handshakes.id, h.id)).run();
    emitEvent({ type: 'handshake.updated', data: { handshakeId: h.id, agentId: h.agentId, status: 'timed_out', latencyMs: null, error: 'Timed out' } });
  }
}, 15_000);

// Startup
const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

runMigrations();
await ensureActiveToken();

app.listen(PORT, '0.0.0.0', () => {
  emitLog(`norc listening on port ${PORT}`);
});
