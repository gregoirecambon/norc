import { Router, type Router as ExpressRouter, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentPlatformGrants, platforms } from '../db/schema.js';
import { assertAgentAuth } from '../lib/auth.js';
import { zodMiddleware } from '../lib/validate.js';
import { listExternalTasks, intakeExternalTask, type IntakeOutcome } from '../lib/external-tasks.js';
import { emitLog } from '../lib/logger.js';
import { norcBaseUrl } from '../lib/base-url.js';

const router: ExpressRouter = Router();

// GET /api/me/platforms — agent retrieves its granted platform API keys
router.get('/platforms', (req, res) => {
  const agent = assertAgentAuth(req, res);
  if (!agent) return;

  const grants = db.select().from(agentPlatformGrants)
    .where(eq(agentPlatformGrants.agentId, agent.id))
    .all();

  const result = grants.map(g => {
    const platform = db.select().from(platforms).where(eq(platforms.id, g.platformId)).all()[0];
    if (!platform) return null;
    return {
      platformId: platform.id,
      name: platform.name,
      description: platform.description,
      apiKey: platform.apiKey,
      grantedAt: g.grantedAt,
    };
  }).filter(Boolean);

  res.json(result);
});

// ── Out-of-band task intake (the "Slack rule") ───────────────────────────────
// An agent asked to do project work OUTSIDE NORC checks here first, then
// creates-or-claims the task. The duplicate gate lives in the POST itself.

// GET /api/me/tasks?project=<name-or-id>&q=<keywords> — open tasks, pre-check view.
router.get('/tasks', async (req, res) => {
  const agent = assertAgentAuth(req, res);
  if (!agent) return;
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

const ExternalTaskSchema = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(10_000).optional(),
  kpis: z.string().max(2_000).optional(),
  project: z.string().max(200).optional(),
  force: z.boolean().optional(),
  existingTaskPageId: z.string().max(64).optional(),
  source: z.string().max(50).optional(),
});

/** Map an intake outcome to its HTTP response. */
function sendIntake(res: Response, out: IntakeOutcome): void {
  switch (out.outcome) {
    case 'not_active': res.status(503).json({ error: 'notion_not_active' }); return;
    case 'no_tasks_db': res.status(503).json({ error: 'no_tasks_db' }); return;
    case 'agent_not_in_org':
      res.status(409).json({ error: 'agent_not_in_org', hint: 'Ask the operator to sync you to the Org DB first.' });
      return;
    case 'title_required': res.status(400).json({ error: 'title_required' }); return;
    case 'project_not_found': res.status(404).json({ error: 'project_not_found', projects: out.projects }); return;
    case 'task_not_found': res.status(404).json({ error: 'task_not_found' }); return;
    case 'not_a_task': res.status(400).json({ error: 'not_a_task' }); return;
    case 'task_closed': res.status(409).json({ error: 'task_closed', status: out.status }); return;
    case 'task_already_active':
      res.status(409).json({ error: 'task_already_active', assignedTo: out.assignedTo });
      return;
    case 'similar':
      res.status(409).json({
        error: 'similar_tasks_exist',
        message: `${out.candidates.length} open task(s) on this project look like the same work. Warn the user and let THEM decide.`,
        candidates: out.candidates,
        hint: 'Re-POST with {"existingTaskPageId":"<id>"} to claim one, or {"force":true} to create anyway — only after the user chose.',
      });
      return;
    case 'created':
    case 'claimed': {
      const status = out.outcome === 'created' ? 201 : 200;
      if (out.claim.mode === 'dispatched') {
        res.status(status).json({
          ok: true, action: out.outcome, mode: 'dispatched',
          task: out.task,
          run: {
            run_id: out.claim.runId,
            notion_page_id: out.task.id,
            api_base: `${norcBaseUrl()}/api/runs/${out.claim.token}`,
          },
          message: 'Task is yours — do the work NOW in your current conversation. Report through api_base like a normal run and ALWAYS finish with POST /complete.',
        });
        return;
      }
      res.status(status).json({
        ok: true, action: out.outcome, mode: 'queued',
        task: out.task,
        queue: { position: out.claim.position, pending: out.claim.pending, reason: out.claim.reason },
        message: 'You are busy — the task is queued at the FRONT of your queue. Tell the user it runs next; NORC will send you the request when your current run finishes. Do NOT start it now.',
      });
      return;
    }
  }
}

// POST /api/me/tasks — create (behind the duplicate gate) or claim a task.
router.post('/tasks', zodMiddleware(ExternalTaskSchema), async (req, res) => {
  const agent = assertAgentAuth(req, res);
  if (!agent) return;
  const body = req.body as z.infer<typeof ExternalTaskSchema>;
  try {
    const out = await intakeExternalTask(agent, body);
    sendIntake(res, out);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Notion API error';
    emitLog(`external task intake failed for "${agent.name}": ${message}`, agent.name);
    res.status(502).json({ error: 'notion_error', message });
  }
});

export { router as meRouter };
