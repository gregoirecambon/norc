// Dashboard snapshot — pure SQLite, fast and pollable. Notion-backed counts
// (scheduled/proposed) are intentionally excluded: the UI composes those from
// /api/tasks/* so this endpoint never blocks on the Notion API.
import { Router, type Router as ExpressRouter } from 'express';
import { eq, ne, desc, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue } from '../db/schema.js';

const router: ExpressRouter = Router();

const runSelection = {
  id: taskRuns.id,
  agentId: taskRuns.agentId,
  agentName: agents.name,
  title: taskRuns.title,
  anchorKind: taskRuns.anchorKind,
  pageId: taskRuns.pageId,
  taskPageId: taskRuns.taskPageId,
  status: taskRuns.status,
  agentActed: taskRuns.agentActed,
  sessionId: taskRuns.sessionId,
  createdAt: taskRuns.createdAt,
  completedAt: taskRuns.completedAt,
};

/** Build a per-run deep-link into the agent's own tool when the agent is configured
 * with `consoleUrlTemplate` in its adapterConfig (e.g. an OpenClaw console). The
 * template's `{sessionKey}`/`{sessionId}` placeholders are filled with the run's
 * session id. Returns null when there's no template or no session — most adapters
 * have no session UI, so the link is simply absent and the UI falls back to the id.
 * Config stays server-side; only the resolved URL is sent to the client. */
function sessionUrlFor(template: unknown, sessionId: string | null): string | null {
  if (typeof template !== 'string' || !template.trim() || !sessionId) return null;
  const enc = encodeURIComponent(sessionId);
  return template.replace(/\{sessionKey\}/g, enc).replace(/\{sessionId\}/g, enc);
}

// GET /api/dashboard — active runs, recent history, basic counts.
router.get('/', (_req, res) => {
  const allAgents = db.select().from(agents).all();
  // agentId → consoleUrlTemplate (if any), for building per-run session deep-links.
  const consoleTemplates = new Map<string, unknown>();
  for (const a of allAgents) {
    try { consoleTemplates.set(a.id, (JSON.parse(a.adapterConfig) as Record<string, unknown>)['consoleUrlTemplate']); }
    catch { /* malformed config → no template */ }
  }
  // Per-agent metadata for the dashboard "resume" helper on remote Claude Code workers:
  // ssh host (from the worker URL / reported hostname) + how to reconstruct the cwd a
  // task ran in (defaultCwd, else <workDir>/<pageId>, else ~/.norc/<pageId>).
  const resumeMeta = new Map<string, { kind: string | null; sshHost: string | null; workDir: string | null; defaultCwd: string | null }>();
  for (const a of allAgents) {
    let cfg: Record<string, unknown> = {};
    let meta: Record<string, unknown> = {};
    try { cfg = JSON.parse(a.adapterConfig); } catch { /* malformed */ }
    try { meta = JSON.parse(a.metadata); } catch { /* malformed */ }
    let sshHost: string | null = null;
    const url = typeof cfg['url'] === 'string' ? cfg['url'] : '';
    if (url) { try { sshHost = new URL(url).hostname; } catch { /* not a url */ } }
    if (!sshHost && typeof meta['host'] === 'string') sshHost = meta['host'];
    resumeMeta.set(a.id, {
      kind: typeof meta['kind'] === 'string' ? meta['kind'] : null,
      sshHost,
      workDir: typeof cfg['workDir'] === 'string' ? cfg['workDir'] : null,
      defaultCwd: typeof cfg['defaultCwd'] === 'string' ? cfg['defaultCwd'] : null,
    });
  }
  const resumeFor = (agentId: string, pageId: string, sessionId: string | null) => {
    const m = resumeMeta.get(agentId);
    if (!m || m.kind !== 'remote-claude-code' || !sessionId) return null;
    const cwd = m.defaultCwd ?? (m.workDir ? `${m.workDir.replace(/\/+$/, '')}/${pageId}` : `~/.norc/${pageId}`);
    return { sshHost: m.sshHost, cwd, sessionId };
  };
  const withSessionUrl = <T extends { agentId: string; sessionId: string | null; pageId: string }>(run: T) =>
    ({
      ...run,
      sessionUrl: sessionUrlFor(consoleTemplates.get(run.agentId), run.sessionId),
      resume: resumeFor(run.agentId, run.pageId, run.sessionId),
    });

  const activeRuns = db.select(runSelection).from(taskRuns)
    .innerJoin(agents, eq(taskRuns.agentId, agents.id))
    .where(eq(taskRuns.status, 'in_flight'))
    .orderBy(desc(taskRuns.createdAt))
    .all()
    .map(withSessionUrl);
  const recentRuns = db.select(runSelection).from(taskRuns)
    .innerJoin(agents, eq(taskRuns.agentId, agents.id))
    .where(ne(taskRuns.status, 'in_flight'))
    .orderBy(desc(taskRuns.completedAt))
    .limit(20)
    .all()
    .map(withSessionUrl);
  const queued = db.select({
    id: dispatchQueue.id,
    agentId: dispatchQueue.agentId,
    agentName: agents.name,
    title: dispatchQueue.title,
    anchorKind: dispatchQueue.anchorKind,
    pageId: dispatchQueue.pageId,
    taskPageId: dispatchQueue.taskPageId,
    projectId: dispatchQueue.projectId,
    priority: dispatchQueue.priority,
    enqueuedAt: dispatchQueue.enqueuedAt,
  }).from(dispatchQueue)
    .innerJoin(agents, eq(dispatchQueue.agentId, agents.id))
    .where(eq(dispatchQueue.status, 'pending'))
    .orderBy(desc(dispatchQueue.priority), asc(dispatchQueue.id))
    .all();
  res.json({
    activeRuns,
    recentRuns,
    queued,
    stats: {
      activeRuns: activeRuns.length,
      queuedItems: queued.length,
      agentsConnected: allAgents.filter(a => a.status === 'connected').length,
      agentsTotal: allAgents.length,
    },
  });
});

export { router as dashboardRouter };
