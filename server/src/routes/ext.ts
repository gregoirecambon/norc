// /api/ext — the machine surface. One Bearer credential (agentSecret or a
// static app key) unlocks a headless view of NORC: who's working, stats,
// projects, task intake, proposal control, and a live event stream. Everything
// here is REDACTED relative to the dashboard routes: no adapter configs, no
// session deep-links, no SSH/resume metadata — those are operator-only.

import { Router, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { eq, ne, desc, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue, notionIntegration, notionDatabases } from '../db/schema.js';
import { extAuthGuard, extPrincipal, requireScope } from '../lib/ext-auth.js';
import { buildStats, STATS_WINDOWS } from '../lib/stats-view.js';
import {
  listExternalTasks, intakeExternalTask, intakeAppTask, listAllProjects,
} from '../lib/external-tasks.js';
import { ExternalTaskSchema, sendIntake } from './me.js';
import { setTaskStatus, archivePage } from '../lib/notion-writeback.js';
import { dispatchScheduledTask } from '../lib/orchestrator.js';
import { attachEventListener, type NorcEvent } from '../lib/events.js';
import { emitLog } from '../lib/logger.js';

export function makeExtRouter(): ExpressRouter {
  const r: ExpressRouter = Router();
  r.use(extAuthGuard);

  // GET /api/ext/me — identity echo; the "is my key wired up?" probe.
  r.get('/me', (req, res) => {
    const p = extPrincipal(req);
    res.json({ kind: p.kind, id: p.id, name: p.name, scopes: p.scopes });
  });

  // GET /api/ext/agents — the registry, redacted (no adapterConfig at all).
  r.get('/agents', requireScope('read'), (_req, res) => {
    res.json(db.select().from(agents).all().map(a => ({
      id: a.id,
      name: a.name,
      adapterType: a.adapterType,
      status: a.status,
      lastPingedAt: a.lastPingedAt,
      maxConcurrentRuns: a.maxConcurrentRuns,
      registeredAt: a.registeredAt,
    })));
  });

  // GET /api/ext/dashboard — active/recent/queued work + counts. Same tables as
  // /api/dashboard, minus session URLs and resume metadata.
  r.get('/dashboard', requireScope('read'), (_req, res) => {
    const runSelection = {
      id: taskRuns.id,
      agentId: taskRuns.agentId,
      agentName: agents.name,
      title: taskRuns.title,
      anchorKind: taskRuns.anchorKind,
      pageId: taskRuns.pageId,
      taskPageId: taskRuns.taskPageId,
      status: taskRuns.status,
      createdAt: taskRuns.createdAt,
      completedAt: taskRuns.completedAt,
    };
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
      priority: dispatchQueue.priority,
      enqueuedAt: dispatchQueue.enqueuedAt,
    }).from(dispatchQueue)
      .innerJoin(agents, eq(dispatchQueue.agentId, agents.id))
      .where(eq(dispatchQueue.status, 'pending'))
      .orderBy(desc(dispatchQueue.priority), asc(dispatchQueue.id))
      .all();
    const allAgents = db.select({ status: agents.status }).from(agents).all();
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

  // GET /api/ext/stats?days=7|30|90
  r.get('/stats', requireScope('read'), async (req, res) => {
    const days = STATS_WINDOWS.includes(Number(req.query['days'])) ? Number(req.query['days']) : 30;
    res.json(await buildStats(days));
  });

  // GET /api/ext/projects — the project roster from the Notion Projects DB.
  r.get('/projects', requireScope('read'), async (_req, res) => {
    try {
      const projects = await listAllProjects();
      if (projects === null) { res.status(503).json({ error: 'notion_not_active' }); return; }
      res.json(projects);
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/ext/tasks?project=&q= — open tasks (same view agents get on /api/me/tasks).
  r.get('/tasks', requireScope('read'), async (req, res) => {
    const project = typeof req.query['project'] === 'string' ? req.query['project'] : undefined;
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    try {
      const result = await listExternalTasks(project, q);
      if (result.outcome === 'not_active') { res.status(503).json({ error: 'notion_not_active' }); return; }
      if (result.outcome === 'no_tasks_db') { res.status(503).json({ error: 'no_tasks_db' }); return; }
      if (result.outcome === 'project_not_found') {
        res.status(404).json({ error: 'project_not_found', projects: result.projects });
        return;
      }
      res.json({ project: result.project, tasks: result.tasks });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'Notion API error' });
    }
  });

  // POST /api/ext/tasks — task intake behind the duplicate gate. Agents
  // create-or-claim (identical to /api/me/tasks); apps create without claiming
  // — Proposed by default, or Backlog + orchestrator routing with route:true
  // (which needs the tasks:approve scope on top of tasks:write).
  const AppTaskSchema = ExternalTaskSchema.omit({ existingTaskPageId: true }).extend({
    route: z.boolean().optional(),
  });
  r.post('/tasks', requireScope('tasks:write'), async (req, res) => {
    const p = extPrincipal(req);
    try {
      if (p.kind === 'agent') {
        const agent = db.select().from(agents).where(eq(agents.id, p.id)).all()[0];
        if (!agent) { res.status(401).json({ error: 'unauthorized' }); return; }
        const parsed = ExternalTaskSchema.safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return; }
        sendIntake(res, await intakeExternalTask(agent, parsed.data));
        return;
      }
      const parsed = AppTaskSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return; }
      if (parsed.data.route === true && !p.scopes.includes('tasks:approve')) {
        res.status(403).json({ error: 'forbidden', hint: "route:true needs the 'tasks:approve' scope — omit it to create a Proposed task instead" });
        return;
      }
      const out = await intakeAppTask({ name: p.name }, { ...parsed.data, source: parsed.data.source ?? p.name });
      switch (out.outcome) {
        case 'not_active': res.status(503).json({ error: 'notion_not_active' }); return;
        case 'no_tasks_db': res.status(503).json({ error: 'no_tasks_db' }); return;
        case 'title_required': res.status(400).json({ error: 'title_required' }); return;
        case 'project_not_found': res.status(404).json({ error: 'project_not_found', projects: out.projects }); return;
        case 'similar':
          res.status(409).json({
            error: 'similar_tasks_exist',
            candidates: out.candidates,
            hint: 'Re-POST with {"force":true} to create anyway.',
          });
          return;
        case 'created':
          res.status(201).json({ ok: true, action: 'created', task: out.task, status: out.status });
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Notion API error';
      emitLog(`ext task intake failed for ${p.kind} "${p.name}": ${message}`);
      res.status(502).json({ error: 'notion_error', message });
    }
  });

  // Proposal control — the headless twin of the dashboard's approve/dismiss.
  const tasksCtx = () => {
    const integration = db.select().from(notionIntegration).all()[0] ?? null;
    if (!integration || integration.status !== 'active' || integration.workspaceStatus !== 'provisioned') return null;
    const tasks = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0] ?? null;
    if (!tasks) return null;
    return { integration, apiKey: integration.apiKey };
  };

  // POST /api/ext/tasks/:id/approve — Proposed → Backlog + route.
  r.post('/tasks/:id/approve', requireScope('tasks:approve'), async (req, res) => {
    const c = tasksCtx();
    if (!c) { res.status(503).json({ error: 'not_ready' }); return; }
    const id = (req.params as { id: string }).id;
    const p = extPrincipal(req);
    try {
      await setTaskStatus(c.apiKey, id, 'Backlog');
      await dispatchScheduledTask(c.integration, id, `approved via API by ${p.kind} "${p.name}"`, `approve:${id}:${Date.now()}`);
      emitLog(`task ${id} approved via API by ${p.kind} "${p.name}" → routed`, 'Triage');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'approve_failed', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/ext/tasks/:id/dismiss — archive a proposal.
  r.post('/tasks/:id/dismiss', requireScope('tasks:approve'), async (req, res) => {
    const c = tasksCtx();
    if (!c) { res.status(503).json({ error: 'not_ready' }); return; }
    const id = (req.params as { id: string }).id;
    const p = extPrincipal(req);
    try {
      await archivePage(c.apiKey, id);
      emitLog(`task ${id} dismissed via API by ${p.kind} "${p.name}"`, 'Triage');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'dismiss_failed', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/ext/events — live SSE. Operational events only: integration
  // internals (notion.*, slack.*) stay dashboard-side.
  const EXT_EVENTS = new Set<NorcEvent['type']>([
    'agent.registered', 'agent.updated', 'agent.deleted',
    'app.created', 'app.updated', 'app.deleted',
    'run.started', 'run.finished', 'queue.updated', 'mention.detected',
  ]);
  r.get('/events', requireScope('read'), (_req, res) => {
    attachEventListener(res, e => EXT_EVENTS.has(e.type));
  });

  return r;
}
