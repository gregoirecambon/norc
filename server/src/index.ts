import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Load from monorepo root, override any shell-set values so .env is always authoritative
dotenvConfig({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', '.env'), override: true });
import express from 'express';
import cors from 'cors';
import { lt, eq } from 'drizzle-orm';
import { runMigrations, closeDb } from './db/client.js';
import { db } from './db/client.js';
import { handshakes, agents } from './db/schema.js';
import { ensureActiveToken } from './lib/tokens.js';
import { emitLog } from './lib/logger.js';
import { emitEvent, onEvent } from './lib/events.js';
import { agentsRouter } from './routes/agents.js';
import { pingRouter } from './routes/ping.js';
import { logsRouter } from './routes/logs.js';
import { eventsRouter } from './routes/events.js';
import { dashboardRouter } from './routes/dashboard.js';
import { platformsRouter } from './routes/platforms.js';
import { meRouter } from './routes/me.js';
import { handshakesRouter, makeCompletionRouter } from './routes/handshakes.js';
import { notionRouter } from './routes/notion.js';
import { notionWebhookRouter } from './routes/notionWebhook.js';
import { slackRouter } from './routes/slack.js';
import { slackWebhookRouter } from './routes/slackWebhook.js';
import { iconsRouter } from './routes/icons.js';
import { makeRunsRouter } from './routes/runs.js';
import { makeTasksRouter } from './routes/tasks.js';
import { skillRouter } from './routes/skill.js';
import { workerRouter } from './routes/worker.js';
import { settingsRouter } from './routes/settings.js';
import { authRouter } from './routes/auth.js';
import { teamRouter } from './routes/team.js';
import { versionRouter } from './routes/version.js';
import { apiAuthGuard, pruneExpiredSessions } from './lib/user-auth.js';
import { startVersionLoop } from './lib/version-check.js';
import { findTimeoutCandidates, finalizeRun, touchRun, getRun, type TaskRun } from './lib/runs.js';
import { probeOpenclawRun } from './adapters/openclaw.js';
import { runHeartbeat, runDeepHeartbeat } from './lib/heartbeat.js';
import { runScheduler } from './lib/scheduler.js';
import { runAutoPropose } from './lib/auto-propose.js';
import { escalateTimedOutRun, drainAgent } from './lib/orchestrator.js';
import { dropPendingForAgentPage, agentsWithPending } from './lib/dispatch-queue.js';
import { getNorcSettingsOrDefault } from './lib/norc-settings.js';
import { ensureNorcAgent } from './lib/norc-identity.js';
import { expireStaleChanges } from './lib/self-changes.js';

const app = express();
app.use(cors());
// Capture the raw request body for the Notion webhook path BEFORE the global
// JSON parser consumes it — HMAC signature verification must hash the exact
// raw bytes. This parser also populates req.body, so the global parser below
// sees it already parsed and skips re-parsing.
app.use('/webhooks/notion', express.json({
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
}));
app.use('/webhooks/slack', express.json({
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
}));
// 15mb: agents ship base64-encoded files through /api/runs/:token/slack-file
// (10 MB file ≈ 13.7 MB encoded). Everything else stays tiny in practice.
app.use(express.json({ limit: '15mb' }));

// Health — also aliased at /api/health so the UI can reach it through the
// Vite dev proxy (which only forwards /api/*).
const health = (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    dbPath: process.env['DATABASE_PATH'] ?? './norc.db',
    ts: new Date().toISOString(),
  });
};
app.get('/health', health);
app.get('/api/health', health);

// Dashboard auth: the auth flow itself is public; everything else under /api
// requires a session cookie, except agent/webhook endpoints that carry their
// own credentials — the single allowlist lives in lib/user-auth.ts.
app.use('/api/auth', authRouter);
app.use('/api', apiAuthGuard);

// Routes
app.use('/api/agents', agentsRouter);
app.use('/api/agents/:id/ping', pingRouter);
app.use('/api/agents/:id/handshake', handshakesRouter);
app.use('/api/handshakes', makeCompletionRouter());
app.use('/api/logs', logsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/platforms', platformsRouter);
app.use('/api/me', meRouter);
app.use('/api/notion', notionRouter);
app.use('/api/slack', slackRouter);
app.use('/api/skill', skillRouter);
app.use('/api/worker', workerRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/runs', makeRunsRouter());
app.use('/api/tasks', makeTasksRouter());
app.use('/api/team', teamRouter);
app.use('/api/version', versionRouter);
app.use('/webhooks/notion', notionWebhookRouter);
app.use('/webhooks/slack', slackWebhookRouter);
// Public like the webhooks: Slack fetches agent avatars here with no credentials.
app.use('/icons', iconsRouter);

// Drop expired dashboard sessions hourly.
setInterval(() => pruneExpiredSessions(), 3600_000);

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

// Time out agent runs left in flight — but a "real" timeout, not a wall-clock
// guess. A run is a candidate when it's been SILENT (no Agent-API activity) past
// the idle window, or has blown the absolute hard cap. Idle OpenClaw candidates
// are PROBED first (agent.wait): if the agent is still executing its deadline is
// extended, not killed — the fix for false-killing a working-but-slow agent. Only
// genuinely silent/dead or hard-capped runs are escalated (free the agent, tell
// the team, re-route). The same pass drains every agent with queued work — the
// missed-event backstop behind the run.finished listener below.
setInterval(() => {
  const s = getNorcSettingsOrDefault();
  const idleMs = Math.max(60, s.runTimeoutSec) * 1000;
  const hardCapMs = Math.max(idleMs, s.runHardCapSec * 1000); // cap can't undercut the idle window
  for (const { run, reason } of findTimeoutCandidates(idleMs, hardCapMs)) {
    void handleTimeoutCandidate(run, reason).catch(err =>
      emitLog(`escalation error for run ${run.id}: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage'));
  }
  for (const agentId of agentsWithPending()) {
    void drainAgent(agentId).catch(err =>
      emitLog(`queue drain error for agent ${agentId}: ${err instanceof Error ? err.message : 'unknown'}`));
  }
  // Pending NORC self-change proposals expire after 7 days (cheap sqlite update).
  const expired = expireStaleChanges();
  if (expired > 0) emitLog(`expired ${expired} stale NORC self-change proposal(s)`);
}, 60_000);

// Resolve one timeout candidate. Idle OpenClaw runs with a known run handle get a
// confirm-before-kill liveness probe; everything else (hard-capped, non-openclaw,
// or no run handle) is timed out directly. Escalation is gated on finalizeRun
// actually transitioning the run, so a run that completed during the ~8s probe
// window is never spuriously escalated.
async function handleTimeoutCandidate(run: TaskRun, reason: 'idle' | 'hardcap'): Promise<void> {
  const agentRow = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];

  if (reason === 'idle' && agentRow?.adapterType === 'openclaw' && run.openclawRunId) {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(agentRow.adapterConfig) as Record<string, unknown>; } catch {
      emitLog(`malformed adapter config for agent ${agentRow.name} — liveness probe skipped`, 'Triage');
    }
    const probe = await probeOpenclawRun(config, run.openclawRunId);
    if (probe.alive) {
      touchRun(run.id);
      const silentSec = Math.round((Date.now() - (run.lastProgressAt ?? run.createdAt)) / 1000);
      emitLog(`run ${run.id} silent ${silentSec}s but "${agentRow.name}" still working${probe.status ? ` (${probe.status})` : ''} — extended`, agentRow.name);
      return;
    }
  }

  if (finalizeRun(run.id, 'timed_out')) await escalateTimedOutRun(run);
}

// Every finalized run frees capacity — drain that agent's queue. On a timeout,
// first drop pending items on the same page: escalation re-routes that work to
// a DIFFERENT agent, so dispatching the queued sibling would double-assign it.
// setImmediate hops off finalizeRun's call stack (emitEvent is synchronous and
// may fire inside a turn — draining inline would recurse dispatch-in-dispatch).
onEvent(event => {
  if (event.type !== 'run.finished') return;
  if (event.data.status === 'timed_out') {
    const run = getRun(event.data.id);
    if (run) dropPendingForAgentPage(run.agentId, run.pageId, 'superseded by timeout escalation');
  }
  setImmediate(() => {
    void drainAgent(event.data.agentId).catch(err =>
      emitLog(`queue drain error for agent ${event.data.agentId}: ${err instanceof Error ? err.message : 'unknown'}`));
  });
});

// Scheduled / recurring tasks — poll the Tasks DB for due "Scheduled For" dates
// and dispatch them (gated by the scheduler toggle).
setInterval(() => {
  if (!getNorcSettingsOrDefault().schedulerEnabled) return;
  void runScheduler().catch(err => emitLog(`scheduler error: ${err instanceof Error ? err.message : 'unknown'}`, 'Schedule'));
}, 60_000);

// Heartbeat — self-rescheduling so live settings changes (interval / enable)
// take effect without a restart.
async function heartbeatLoop(): Promise<void> {
  const settings = getNorcSettingsOrDefault();
  if (settings.heartbeatEnabled) {
    try { await runHeartbeat(); } catch (err) {
      emitLog(`heartbeat error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  const intervalMs = Math.max(10, settings.heartbeatIntervalSec) * 1000;
  setTimeout(() => { void heartbeatLoop(); }, intervalMs);
}

// Deep heartbeat — a real test prompt through each agent's AI stack, on its own
// (longer) cadence since every check is a real AI call. Same self-rescheduling
// pattern; gated on the master heartbeat toggle too, so "heartbeat off" means
// "never probe agents".
async function deepHeartbeatLoop(): Promise<void> {
  const settings = getNorcSettingsOrDefault();
  if (settings.heartbeatEnabled && settings.deepPingEnabled) {
    try { await runDeepHeartbeat(); } catch (err) {
      emitLog(`deep heartbeat error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  const intervalMs = Math.max(60, settings.deepPingIntervalSec) * 1000;
  setTimeout(() => { void deepHeartbeatLoop(); }, intervalMs);
}

// Recurring co-CEO analysis — self-rescheduling so the interval/enable toggle
// take effect live. Proposes tasks (as 'Proposed', human-validated) every N hours.
async function autoProposeLoop(): Promise<void> {
  const settings = getNorcSettingsOrDefault();
  if (settings.autoProposeEnabled) {
    try { await runAutoPropose(); } catch (err) {
      emitLog(`auto-propose error: ${err instanceof Error ? err.message : 'unknown'}`, 'Co-CEO');
    }
  }
  const intervalMs = Math.max(1, Math.min(24, settings.autoProposeIntervalHours)) * 3600_000;
  setTimeout(() => { void autoProposeLoop(); }, intervalMs);
}

// Startup
const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

runMigrations();
await ensureActiveToken();

const server = app.listen(PORT, '0.0.0.0', () => {
  emitLog(`norc listening on port ${PORT}`);
  // Resume queued work that survived a restart (the queue is durable).
  setTimeout(() => {
    for (const agentId of agentsWithPending()) {
      void drainAgent(agentId).catch(err =>
        emitLog(`boot drain error for agent ${agentId}: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  }, 8_000);
  // Kick off the heartbeat shortly after boot so startup settles first.
  setTimeout(() => { void heartbeatLoop(); }, 5_000);
  // Ensure NORC's own Org DB page exists (Type = Orchestrator) — idempotent,
  // self-healing, no-op until the workspace is provisioned.
  setTimeout(() => { void ensureNorcAgent(); }, 6_000);
  // Deep heartbeat a bit later still (each check is a real AI call).
  setTimeout(() => { void deepHeartbeatLoop(); }, 20_000);
  // Recurring co-CEO analysis (first check a bit later; runs only when enabled).
  setTimeout(() => { void autoProposeLoop(); }, 30_000);
  // Update check against GitHub releases (re-checks every ~6h).
  setTimeout(() => { void startVersionLoop(); }, 10_000);
});

// Graceful shutdown: stop accepting connections, checkpoint the SQLite WAL,
// exit. Open SSE streams (/api/logs, /api/events) hold server.close() open
// indefinitely, so a short force-exit timer backstops it.
function shutdown(signal: string): void {
  emitLog(`norc shutting down (${signal})`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5_000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
