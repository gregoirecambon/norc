// The NORC Agent API — token-scoped endpoints agents call to act on Notion.
// The opaque run token (in the path) authenticates the run and resolves to the
// originating page, so NORC writes land on the right place automatically. Agents
// never handle Notion ids; they may optionally target another accessible page.

import { Router, type Router as ExpressRouter } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, agents, orchestratorComments } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { getActiveRunByToken, markActed, type TaskRun } from '../lib/runs.js';
import {
  postComment, postCommentReply, appendBlocks, setTaskStatus, setTaskFields,
  type TaskStatus,
} from '../lib/notion-writeback.js';
import { markdownToBlocks } from '../lib/notion-blocks-md.js';
import { readPageMarkdown, resolveAnchor } from '../lib/notion-anchor.js';
import { getAnyTitle, getSelect } from '../lib/notion-props.js';
import { notionGet, notionPost, notionQuery } from '../lib/notion-client.js';
import { assembleContext, type ContextLevel } from '../lib/context-assembler.js';
import { proposeTasks, releaseDependents, finalizeAgentReport } from '../lib/orchestrator.js';
import type { AgentRef } from '../lib/notion-mentions.js';

/** Open Notion search/query is opt-in (off by default) and strategic-only. */
function openSearchEnabled(): boolean {
  return process.env['NORC_OPEN_SEARCH'] === '1' || process.env['NORC_OPEN_SEARCH'] === 'true';
}

function agentRefForRun(run: TaskRun): AgentRef | null {
  const a = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];
  if (!a) return null;
  return { agentId: a.id, orgDbPageId: a.orgDbPageId ?? '', name: a.name, adapterType: a.adapterType };
}

/** Log tag for a run: the agent's display name (NORC if it was deleted mid-run). */
function agentTag(run: TaskRun): string {
  return agentRefForRun(run)?.name ?? 'NORC';
}

/** Re-read the agent's Org DB Context Level to gate higher-privilege pulls. */
async function agentClearance(apiKey: string, run: TaskRun): Promise<ContextLevel> {
  const a = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];
  if (!a?.orgDbPageId) return 'project';
  try {
    const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${a.orgDbPageId}`);
    const lvl = getSelect(page['properties'], 'Context Level');
    if (lvl === 'task' || lvl === 'project' || lvl === 'strategic') return lvl;
  } catch { /* fall through */ }
  return 'project';
}

/** Shared gate for open search/query: global flag + strategic clearance. */
async function requireOpenSearch(apiKey: string, run: TaskRun, res: import('express').Response): Promise<boolean> {
  if (!openSearchEnabled()) {
    res.status(403).json({ error: 'search_disabled', message: 'Open Notion search is disabled (set NORC_OPEN_SEARCH=1).' });
    return false;
  }
  if (await agentClearance(apiKey, run) !== 'strategic') {
    res.status(403).json({ error: 'insufficient_clearance', message: 'Open search/query requires a strategic agent.' });
    return false;
  }
  return true;
}

function activeIntegration() {
  const row = db.select().from(notionIntegration).all()[0] ?? null;
  return row && row.status === 'active' ? row : null;
}

function activeApiKey(): string | null {
  return activeIntegration()?.apiKey ?? null;
}

/** A task just went Done — kick the dependency release (fire-and-forget). */
function releaseAfterDone(taskPageId: string): void {
  const integration = activeIntegration();
  if (!integration) return;
  void releaseDependents(integration, taskPageId).catch(err =>
    emitLog(`dependency release failed for ${taskPageId}: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage', taskPageId));
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
        emitLog(`agent API: reply posted on discussion ${discussionId} (run ${run.id})`, agentTag(run));
      } else {
        const target = typeof pageId === 'string' && pageId ? pageId : run.pageId;
        await recordOurComment(apiKey, target, text);
        markActed(run.id);
        emitLog(`agent API: comment posted on page ${target} (run ${run.id})`, agentTag(run));
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/runs/:token/page?pageId=&depth=  → { title, url, markdown }
  // The fuller page detail an agent can pull when the prompt only gave it a link.
  // `depth` (1–5, default 3) controls how far nested blocks are followed.
  r.get('/:token/page', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    const pageId = typeof req.query['pageId'] === 'string' && req.query['pageId']
      ? req.query['pageId'] as string
      : run.pageId;
    const depth = Math.max(1, Math.min(5, parseInt(String(req.query['depth'] ?? '3'), 10) || 3));
    try {
      const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${pageId}`);
      const markdown = await readPageMarkdown(apiKey, pageId, 12_000, depth);
      emitLog(`agent API: page ${pageId} read (run ${run.id}, depth ${depth})`, agentTag(run));
      res.json({
        title: getAnyTitle(page['properties']),
        url: typeof page['url'] === 'string' ? page['url'] : null,
        markdown,
      });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/runs/:token/context  → the structured context NORC assembled for this
  // run (BYO-SDK parity): the same blocks injected into the prompt, as JSON, so a
  // capable agent can consume them directly instead of parsing the prompt text.
  r.get('/:token/context', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    const agentRef = agentRefForRun(run);
    if (!agentRef) { res.status(404).json({ error: 'agent_not_found' }); return; }
    try {
      const anchor = await resolveAnchor(apiKey, run.pageId);
      const ctx = await assembleContext({ apiKey, anchor, agentRef });
      emitLog(`agent API: context pulled (run ${run.id}, level ${ctx.contextLevel})`, agentRef.name);
      res.json({
        contextLevel: ctx.contextLevel,
        anchorKind: anchor.kind,
        task: ctx.taskBlock,
        project: ctx.projectBlock,
        company: ctx.companyBlocks,
        related: ctx.relatedBlocks,
        body: ctx.bodyMarkdown,
        projectBody: ctx.projectBody,
      });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // GET /api/runs/:token/search?q=  → proxy Notion search (strategic agents only,
  // and only when NORC_OPEN_SEARCH is enabled). Lets a company-brain agent explore.
  r.get('/:token/search', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    if (!await requireOpenSearch(apiKey, run, res)) return;
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    try {
      const body = await notionPost<Record<string, unknown>>(apiKey, '/search', { query: q, page_size: 10 });
      const raw = Array.isArray(body['results']) ? body['results'] as Record<string, unknown>[] : [];
      const results = raw.map(p => ({
        id: String(p['id'] ?? ''),
        object: p['object'],
        title: getAnyTitle(p['properties']),
        url: typeof p['url'] === 'string' ? p['url'] : null,
      }));
      emitLog(`agent API: search "${q.slice(0, 40)}" → ${results.length} (run ${run.id})`, agentTag(run));
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/query  { databaseId, filter?, sorts?, pageSize? }
  // Structured DB read for strategic agents (same gate as search).
  r.post('/:token/query', async (req, res) => {
    const { run, apiKey } = req as unknown as { run: TaskRun; apiKey: string };
    if (!await requireOpenSearch(apiKey, run, res)) return;
    const { databaseId, filter, sorts, pageSize } = req.body as {
      databaseId?: string; filter?: unknown; sorts?: unknown; pageSize?: number;
    };
    if (!databaseId || typeof databaseId !== 'string') { res.status(400).json({ error: 'databaseId_required' }); return; }
    try {
      const body = await notionQuery<Record<string, unknown>>(apiKey, databaseId, {
        ...(filter ? { filter } : {}),
        ...(sorts ? { sorts } : {}),
        page_size: Math.max(1, Math.min(100, typeof pageSize === 'number' ? pageSize : 25)),
      });
      const raw = Array.isArray(body['results']) ? body['results'] as Record<string, unknown>[] : [];
      const results = raw.map(p => ({
        id: String(p['id'] ?? ''),
        title: getAnyTitle(p['properties']),
        url: typeof p['url'] === 'string' ? p['url'] : null,
        properties: p['properties'],
      }));
      emitLog(`agent API: query db ${databaseId} → ${results.length} (run ${run.id})`, agentTag(run));
      res.json({ results });
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
      emitLog(`agent API: ${blocks.length} block(s) appended to page ${target} (run ${run.id})`, agentTag(run));
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
        if (status === 'Done') releaseAfterDone(run.taskPageId);
      }
      if (typeof agentOutput === 'string') await setTaskFields(apiKey, run.taskPageId, { agentOutput });
      markActed(run.id);
      emitLog(`agent API: task status/fields updated (run ${run.id})`, agentTag(run));
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/propose-tasks
  //   { tasks: [{ title, description?, kpis?, dependsOn?: number[] }] }
  // An agent hands NORC follow-up work; NORC creates Backlog tasks and triages each
  // (auto-route when confident, else ask the human + email). `dependsOn` entries are
  // indices of EARLIER tasks in the same batch (a DAG by construction) — dependent
  // tasks are created held and auto-released as their predecessors complete.
  r.post('/:token/propose-tasks', async (req, res) => {
    const { run } = req as unknown as { run: TaskRun; apiKey: string };
    const { tasks } = req.body as { tasks?: { title?: string; description?: string; kpis?: string; dependsOn?: unknown }[] };
    if (!Array.isArray(tasks) || tasks.length === 0) { res.status(400).json({ error: 'tasks_required' }); return; }
    const submitted = tasks.slice(0, 20);
    // Build the clean list, remembering submitted-index → clean-index so
    // dependsOn references survive dropped (titleless) entries.
    const cleanIdx = new Map<number, number>();
    const clean: { title: string; description?: string; kpis?: string; dependsOn?: number[] }[] = [];
    for (let i = 0; i < submitted.length; i++) {
      const t = submitted[i];
      if (!t || typeof t.title !== 'string' || !t.title.trim()) continue;
      cleanIdx.set(i, clean.length);
      clean.push({
        title: t.title.trim(),
        description: typeof t.description === 'string' ? t.description : undefined,
        kpis: typeof t.kpis === 'string' ? t.kpis : undefined,
      });
    }
    if (clean.length === 0) { res.status(400).json({ error: 'title_required' }); return; }
    for (let i = 0; i < submitted.length; i++) {
      const t = submitted[i];
      const ci = cleanIdx.get(i);
      if (ci === undefined || t?.dependsOn === undefined) continue;
      const deps = t.dependsOn;
      const valid = Array.isArray(deps) && deps.every(v =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < i && cleanIdx.has(v));
      if (!valid) {
        res.status(400).json({ error: 'bad_dependsOn', message: 'each dependsOn entry must be the index of an EARLIER task in this batch' });
        return;
      }
      clean[ci]!.dependsOn = (deps as number[]).map(v => cleanIdx.get(v)!);
    }
    const proposer = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0]?.name;
    try {
      const { created } = await proposeTasks({ sourcePageId: run.pageId, proposerName: proposer, tasks: clean });
      markActed(run.id);
      emitLog(`agent API: ${created.length} task(s) proposed (run ${run.id})`, proposer ?? 'NORC');
      res.json({ ok: true, created });
    } catch (err) {
      res.status(502).json({ error: 'propose_failed', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  // POST /api/runs/:token/complete  { status: 'done'|'failed'|'blocked', summary? }
  // Delegates to the shared orchestrator finalizer, which ALWAYS posts a visible
  // comment, drives task status, and parks give-up / blocked reports for a human
  // (so a "can't do it" report never silently flips the task to Done).
  r.post('/:token/complete', async (req, res) => {
    const { run } = req as unknown as { run: TaskRun; apiKey: string };
    const { status, summary } = req.body as { status?: string; summary?: string };
    markActed(run.id);
    try {
      await finalizeAgentReport(run, { status, summary });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: 'notion_error', message: err instanceof Error ? err.message : 'failed' });
    }
  });

  return r;
}
