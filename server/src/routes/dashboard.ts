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
  createdAt: taskRuns.createdAt,
  completedAt: taskRuns.completedAt,
};

// GET /api/dashboard — active runs, recent history, basic counts.
router.get('/', (_req, res) => {
  const activeRuns = db.select(runSelection).from(taskRuns)
    .innerJoin(agents, eq(taskRuns.agentId, agents.id))
    .where(eq(taskRuns.status, 'in_flight'))
    .orderBy(desc(taskRuns.createdAt))
    .all();
  const recentRuns = db.select(runSelection).from(taskRuns)
    .innerJoin(agents, eq(taskRuns.agentId, agents.id))
    .where(ne(taskRuns.status, 'in_flight'))
    .orderBy(desc(taskRuns.completedAt))
    .limit(20)
    .all();
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
  const allAgents = db.select().from(agents).all();
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
