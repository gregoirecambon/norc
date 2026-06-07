// Read + manage Notion tasks from the dashboard: list the co-CEO's Proposed tasks
// and the scheduled/recurring tasks, and approve (→ Backlog + route) or dismiss
// (→ archive) a proposal. Thin wrappers over notionQuery + existing write-backs.

import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases } from '../db/schema.js';
import { notionQuery } from '../lib/notion-client.js';
import { getAnyTitle, getRichText, getSelect, getDate, getNumber, getRelationIds } from '../lib/notion-props.js';
import { matchAgents } from '../lib/notion-mentions.js';
import { setTaskStatus, archivePage } from '../lib/notion-writeback.js';
import { dispatchScheduledTask } from '../lib/orchestrator.js';
import { emitLog } from '../lib/logger.js';

type Ctx = { integration: typeof notionIntegration.$inferSelect; apiKey: string; tasksDbId: string };

function getCtx(): Ctx | null {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active' || integration.workspaceStatus !== 'provisioned') return null;
  const tasks = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0] ?? null;
  if (!tasks) return null;
  return { integration, apiKey: integration.apiKey, tasksDbId: tasks.notionDatabaseId };
}

function rowsOf(q: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(q['results']) ? q['results'] as Record<string, unknown>[] : [];
}

export function makeTasksRouter(): ExpressRouter {
  const r: ExpressRouter = Router();

  // GET /api/tasks/proposed — co-CEO proposals awaiting human validation.
  r.get('/proposed', async (_req, res) => {
    const c = getCtx();
    if (!c) { res.status(400).json({ error: 'not_ready', message: 'Provision the Notion workspace first.' }); return; }
    try {
      const q = await notionQuery<Record<string, unknown>>(c.apiKey, c.tasksDbId, {
        filter: { property: 'Status', select: { equals: 'Proposed' } },
        page_size: 50,
      });
      res.json(rowsOf(q).map(p => ({
        id: String(p['id'] ?? ''),
        title: getAnyTitle(p['properties']) || '(untitled)',
        url: typeof p['url'] === 'string' ? p['url'] : null,
        kpis: getRichText(p['properties'], 'KPIs'),
        createdTime: typeof p['created_time'] === 'string' ? p['created_time'] : null,
      })));
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/tasks/scheduled — tasks with a "Scheduled For" date (next-run view).
  r.get('/scheduled', async (_req, res) => {
    const c = getCtx();
    if (!c) { res.status(400).json({ error: 'not_ready', message: 'Provision the Notion workspace first.' }); return; }
    try {
      const q = await notionQuery<Record<string, unknown>>(c.apiKey, c.tasksDbId, {
        filter: { property: 'Scheduled For', date: { is_not_empty: true } },
        sorts: [{ property: 'Scheduled For', direction: 'ascending' }],
        page_size: 50,
      });
      const out = rowsOf(q)
        .map(p => {
          const props = p['properties'];
          return {
            id: String(p['id'] ?? ''),
            title: getAnyTitle(props) || '(untitled)',
            url: typeof p['url'] === 'string' ? p['url'] : null,
            scheduledFor: getDate(props, 'Scheduled For'),
            recurrence: getSelect(props, 'Recurrence') ?? 'None',
            repeatEvery: getNumber(props, 'Repeat Every (days)'),
            status: getSelect(props, 'Status') ?? '',
            assignees: matchAgents(getRelationIds(props, 'Assigned To')).map(a => a.name),
          };
        })
        .filter(t => t.status !== 'Proposed');
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/tasks/:id/approve — validate a proposal: Backlog + route/assign.
  r.post('/:id/approve', async (req, res) => {
    const c = getCtx();
    if (!c) { res.status(400).json({ error: 'not_ready' }); return; }
    const id = (req.params as { id: string }).id;
    try {
      await setTaskStatus(c.apiKey, id, 'Backlog');
      await dispatchScheduledTask(c.integration, id, 'approved proposal', `approve:${id}:${Date.now()}`);
      emitLog(`task ${id} approved → routed`, 'Triage');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'approve_failed', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/tasks/:id/dismiss — archive a proposal (Notion trash).
  r.post('/:id/dismiss', async (req, res) => {
    const c = getCtx();
    if (!c) { res.status(400).json({ error: 'not_ready' }); return; }
    const id = (req.params as { id: string }).id;
    try {
      await archivePage(c.apiKey, id);
      emitLog(`task ${id} dismissed (archived)`, 'Triage');
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'dismiss_failed', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  return r;
}
