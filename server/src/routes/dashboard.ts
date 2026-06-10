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
  const withSessionUrl = <T extends { agentId: string; sessionId: string | null }>(run: T) =>
    ({ ...run, sessionUrl: sessionUrlFor(consoleTemplates.get(run.agentId), run.sessionId) });

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
