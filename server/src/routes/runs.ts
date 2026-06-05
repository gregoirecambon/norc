// The NORC Agent API — token-scoped endpoints agents call to act on Notion.
// The opaque run token (in the path) authenticates the run and resolves to the
// originating page, so NORC writes land on the right place automatically. Agents
// never handle Notion ids; they may optionally target another accessible page.

import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, agents, orchestratorComments } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { getActiveRunByToken, markActed, finalizeRun, type TaskRun } from '../lib/runs.js';
import {
  postComment, postCommentReply, appendBlocks, setTaskStatus, setTaskFields, setAgentStatus,
  type TaskStatus,
} from '../lib/notion-writeback.js';
import { markdownToBlocks } from '../lib/notion-blocks-md.js';

function activeApiKey(): string | null {
  const row = db.select().from(notionIntegration).all()[0] ?? null;
  return row && row.status === 'active' ? row.apiKey : null;
}

function recordCommentId(commentId: string): void {
  if (commentId) {
    db.insert(orchestratorComments).values({ commentId, createdAt: Date.now() }).onConflictDoNothing().run();
  }
}

async function recordOurComment(apiKey: string, pageId: string, text: string): Promise<void> {
  recordCommentId((await postComment(apiKey, pageId, text)).commentId);
}

export function makeRunsRouter(): ExpressRouter {
  const r: ExpressRouter = Router({ mergeParams: true });

  // Resolve the run token for every /:token/* route.
  r.use('/:token', (req, res, next) => {
    const run = getActiveRunByToken((req.params as { token: string }).token);
    if (!run) { res.status(404).json({ error: 'invalid_or_expired_token' }); return; }
    const apiKey = activeApiKey();
    if (!apiKey) { res.status(503).json({ error: 'notion_not_active' }); return; }
    (req as unknown as { run: TaskRun; apiKey: string }).run = run;
    (req as unknown as { run: TaskRun; apiKey: string }).apiKey = apiKey;
    next();
  });

  // POST /api/runs/:token/comment  { text, pageId?, discussionId? }
  // discussionId (= reply_discussion_id from the run block) threads the reply onto
  // the precise text; otherwise the comment lands page-level on pageId/run.pageId.
  r.post('/:token/comment', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    const { text, pageId, discussionId } = req.body as { text?: string; pageId?: string; discussionId?: string };
    if (!text || typeof text !== 'string') { res.status(400).json({ error: 'text_required' }); return; }
    try {
      if (typeof discussionId === 'string' && discussionId) {
        recordCommentId((await postCommentReply(apiKey, discussionId, text)).commentId);
        markActed(run.id);
        emitLog(`agent API: reply posted on discussion ${discussionId} (run ${run.id})`);
      } else {
        const target = typeof pageId === 'string' && pageId ? pageId : run.pageId;
        await recordOurComment(apiKey, target, text);
        markActed(run.id);
        emitLog(`agent API: comment posted on page ${target} (run ${run.id})`);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/blocks  { markdown, pageId? }
  r.post('/:token/blocks', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    const { markdown, pageId } = req.body as { markdown?: string; pageId?: string };
    if (!markdown || typeof markdown !== 'string') { res.status(400).json({ error: 'markdown_required' }); return; }
    const target = typeof pageId === 'string' && pageId ? pageId : run.pageId;
    try {
      const blocks = markdownToBlocks(markdown);
      await appendBlocks(apiKey, target, blocks);
      markActed(run.id);
      emitLog(`agent API: ${blocks.length} block(s) appended to page ${target} (run ${run.id})`);
      res.json({ ok: true, blocks: blocks.length });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/status  { status?, agentOutput? }  (task anchors only)
  r.post('/:token/status', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    if (!run.taskPageId) { res.status(409).json({ error: 'not_a_task', message: 'This run is not anchored on a Task.' }); return; }
    const { status, agentOutput } = req.body as { status?: string; agentOutput?: string };
    const allowed: TaskStatus[] = ['Backlog', 'In Progress', 'Done', 'Failed'];
    try {
      if (status) {
        if (!allowed.includes(status as TaskStatus)) { res.status(400).json({ error: 'bad_status', allowed }); return; }
        await setTaskStatus(apiKey, run.taskPageId, status as TaskStatus);
      }
      if (typeof agentOutput === 'string') await setTaskFields(apiKey, run.taskPageId, { agentOutput });
      markActed(run.id);
      emitLog(`agent API: task status/fields updated (run ${run.id})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/complete  { status: 'done'|'failed', summary? }
  r.post('/:token/complete', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    const { status, summary } = req.body as { status?: string; summary?: string };
    const ok = status !== 'failed';
    try {
      if (typeof summary === 'string' && summary.trim()) {
        await recordOurComment(apiKey, run.pageId, summary.trim());
      }
      if (run.manageTaskStatus && run.taskPageId) {
        await setTaskStatus(apiKey, run.taskPageId, ok ? 'Done' : 'Failed');
        if (typeof summary === 'string' && summary.trim()) {
          await setTaskFields(apiKey, run.taskPageId, { agentOutput: summary.trim() });
        }
      }
      const agentRow = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];
      if (agentRow?.orgDbPageId) await setAgentStatus(apiKey, agentRow.orgDbPageId, 'Available');
      markActed(run.id);
      finalizeRun(run.id, ok ? 'done' : 'failed');
      emitLog(`agent API: run ${run.id} completed (${ok ? 'done' : 'failed'})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  return r;
}
