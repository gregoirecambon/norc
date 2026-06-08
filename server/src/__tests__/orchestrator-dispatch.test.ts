import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ─── Mocks: everything that talks to the network ─────────────────────────────

vi.mock('../adapters/index.js', () => ({
  dispatch: vi.fn(async () => ({ ok: true, supported: true, text: 'done by agent' })),
  dispatchSupported: vi.fn(() => true),
  pingAgent: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
  notifySkillUpdate: vi.fn(async () => ({ pushed: false })),
}));

// Anchors are fabricated per test through this map. Partial mock: pure helpers
// (richTextToPlain etc., used by notion-props) stay real; network calls don't.
interface FakeAnchor {
  kind: 'task' | 'project' | 'page';
  pageId: string;
  parentDatabaseId: string | null;
  page: Record<string, unknown>;
}
const anchors = new Map<string, FakeAnchor>();
vi.mock('../lib/notion-anchor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/notion-anchor.js')>(),
  resolveAnchor: vi.fn(async (_key: string, pageId: string) => {
    const a = anchors.get(pageId);
    if (!a) throw new Error(`Could not find page with ID: ${pageId} (404)`);
    return a;
  }),
  listThreadComments: vi.fn(async () => []),
  collectBlockMentionPageIds: vi.fn(async () => []),
  readBlockText: vi.fn(async () => ''),
  userDisplayName: vi.fn(async () => 'User'),
  readPageMarkdown: vi.fn(async () => ''),
}));

vi.mock('../lib/notion-writeback.js', () => ({
  postComment: vi.fn(async () => ({ commentId: 'c1' })),
  postCommentReply: vi.fn(async () => ({ commentId: 'c2' })),
  postCommentMentioning: vi.fn(async () => ({ commentId: 'c3' })),
  postCommentReplyMentioning: vi.fn(async () => ({ commentId: 'c4' })),
  postCommentRich: vi.fn(async () => ({ commentId: 'c5' })),
  postCommentReplyRich: vi.fn(async () => ({ commentId: 'c6' })),
  appendBlocks: vi.fn(async () => undefined),
  setTaskStatus: vi.fn(async () => undefined),
  setTaskAssignee: vi.fn(async () => undefined),
  setTaskFields: vi.fn(async () => undefined),
  setAgentStatus: vi.fn(async () => undefined),
  touchLastActive: vi.fn(async () => undefined),
  createTaskPage: vi.fn(async () => ({ pageId: 'new-task' })),
  setTaskScheduledFor: vi.fn(async () => undefined),
  archivePage: vi.fn(async () => undefined),
}));

vi.mock('../lib/context-assembler.js', () => ({
  assembleContext: vi.fn(async () => ({
    contextLevel: 'project', taskBlock: null, projectBlock: null,
    companyBlocks: [], relatedBlocks: [], bodyMarkdown: '', fingerprint: 'fp',
  })),
  buildPrompt: vi.fn(() => ({ system: 'SYS', prompt: 'PROMPT' })),
}));

// Dep-status reads + dependent queries are steered through these maps.
const notionPages = new Map<string, Record<string, unknown>>();
let queryResults: Record<string, unknown>[] = [];
vi.mock('../lib/notion-client.js', () => ({
  NOTION_API: 'https://api.notion.com/v1',
  NOTION_VERSION: '2022-06-28',
  headers: () => ({}),
  notionGet: vi.fn(async (_k: string, path: string) => {
    const id = path.replace('/pages/', '');
    const p = notionPages.get(id);
    if (!p) throw new Error(`Could not find page with ID: ${id} (404)`);
    return p;
  }),
  notionPost: vi.fn(async () => ({})),
  notionPatch: vi.fn(async () => ({})),
  notionQuery: vi.fn(async () => ({ results: queryResults, has_more: false })),
}));

// ─── Real modules under test ──────────────────────────────────────────────────

import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue, notionIntegration, notionDatabases, processedTriggers } from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { requestAgentTurn, drainAgent, releaseDependents, finalizeAgentReport } from '../lib/orchestrator.js';
import { runScheduler } from '../lib/scheduler.js';
import { triage } from '../lib/orchestrator-agent.js';
import { createRun, finalizeRun } from '../lib/runs.js';
import { pendingCount, pendingItems } from '../lib/dispatch-queue.js';
import { dispatch } from '../adapters/index.js';
import { setTaskStatus, postComment, setAgentStatus } from '../lib/notion-writeback.js';
import { listThreadComments } from '../lib/notion-anchor.js';
import { assembleContext } from '../lib/context-assembler.js';
import type { AgentRef } from '../lib/notion-mentions.js';

const dispatchMock = vi.mocked(dispatch);
const setTaskStatusMock = vi.mocked(setTaskStatus);
const postCommentMock = vi.mocked(postComment);
const setAgentStatusMock = vi.mocked(setAgentStatus);
const listThreadMock = vi.mocked(listThreadComments);
const assembleMock = vi.mocked(assembleContext);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function taskProps(opts: { title?: string; status?: string; projectId?: string | null; deps?: string[]; assignees?: string[]; scheduledFor?: string; recurrence?: string } = {}) {
  return {
    'Name': { type: 'title', title: [{ plain_text: opts.title ?? 'a task' }] },
    'Status': { type: 'select', select: { name: opts.status ?? 'Backlog' } },
    ...(opts.projectId ? { 'Project': { type: 'relation', relation: [{ id: opts.projectId }] } } : {}),
    'Depends On': { type: 'relation', relation: (opts.deps ?? []).map(id => ({ id })) },
    'Assigned To': { type: 'relation', relation: (opts.assignees ?? []).map(id => ({ id })) },
    ...(opts.scheduledFor ? { 'Scheduled For': { type: 'date', date: { start: opts.scheduledFor } } } : {}),
    ...(opts.recurrence ? { 'Recurrence': { type: 'select', select: { name: opts.recurrence } } } : {}),
  };
}

function setTaskAnchor(pageId: string, opts: Parameters<typeof taskProps>[0] = {}) {
  anchors.set(pageId, { kind: 'task', pageId, parentDatabaseId: 'tasks-db', page: { properties: taskProps({ title: pageId, ...opts }) } });
}

function addAgent(id: string, name: string, maxConcurrentRuns = 1, orgDbPageId = `org-${id}`) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'connected',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns, orgDbPageId,
  }).run();
}

const ref = (agentId: string, name: string): AgentRef =>
  ({ agentId, orgDbPageId: `org-${agentId}`, name, adapterType: 'http' });

function getIntegration() {
  return db.select().from(notionIntegration).all()[0]!;
}

const turnOpts = (over: Record<string, unknown> = {}) => ({
  thread: [], request: 'do the work', manageTaskStatus: true, how: 'assignment', ...over,
});

beforeAll(() => {
  runMigrations();
  db.insert(notionIntegration).values({
    id: 'i1', apiKey: 'k', status: 'active', workspaceStatus: 'provisioned',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  db.insert(notionDatabases).values({
    id: 'db1', kind: 'tasks', notionDatabaseId: 'tasks-db', title: 'Tasks', createdAt: Date.now(),
  }).run();
});

beforeEach(() => {
  db.delete(dispatchQueue).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  db.delete(processedTriggers).run();
  anchors.clear();
  notionPages.clear();
  queryResults = [];
  dispatchMock.mockClear();
  dispatchMock.mockResolvedValue({ ok: true, supported: true, text: 'done by agent' });
  setTaskStatusMock.mockClear();
  postCommentMock.mockClear();
  setAgentStatusMock.mockClear();
  listThreadMock.mockClear();
  assembleMock.mockClear();
  addAgent('a1', 'alpha', 1);
});

// ─── The capacity gate ────────────────────────────────────────────────────────

describe('requestAgentTurn — capacity gate', () => {
  it('dispatches immediately when the agent has capacity', async () => {
    setTaskAnchor('t1', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('t1')!, ref('a1', 'alpha'), turnOpts());
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(pendingCount('a1')).toBe(0);
    const run = db.select().from(taskRuns).all()[0]!;
    expect(run.status).toBe('done');
    expect(run.projectId).toBe('projA');
    expect(run.lane).toBe('work');
  });

  it('queues (and sets Status Queued) when the agent is at its cap', async () => {
    createRun({ agentId: 'a1', pageId: 'busy-page', taskPageId: 'busy-page', anchorKind: 'task', projectId: 'projZ', manageTaskStatus: true });
    setTaskAnchor('t2', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('t2')!, ref('a1', 'alpha'), turnOpts());
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(pendingCount('a1')).toBe(1);
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 't2', 'Queued');
  });

  it('queues on a same-project conflict even with spare capacity (HARD rule)', async () => {
    db.update(agents).set({ maxConcurrentRuns: 5 }).where(eq(agents.id, 'a1')).run();
    createRun({ agentId: 'a1', pageId: 'other-task', taskPageId: 'other-task', anchorKind: 'task', projectId: 'projA', manageTaskStatus: true });
    setTaskAnchor('t3', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('t3')!, ref('a1', 'alpha'), turnOpts());
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(pendingCount('a1')).toBe(1);
  });

  it('chat lane bypasses the gate, runs in parallel on an isolated #chat session', async () => {
    createRun({ agentId: 'a1', pageId: 't4', taskPageId: 't4', anchorKind: 'task', projectId: 'projA', manageTaskStatus: true });
    setTaskAnchor('t4', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('t4')!, ref('a1', 'alpha'),
      turnOpts({ manageTaskStatus: false, lane: 'chat', how: 'comment mention' }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]![0].sessionId).toBe('t4#chat');
    expect(pendingCount('a1')).toBe(0);
    const chatRun = db.select().from(taskRuns).where(eq(taskRuns.lane, 'chat')).all()[0]!;
    expect(chatRun.status).toBe('done');
  });

  it('finalizes a pre-minted run as failed when the turn throws', async () => {
    assembleMock.mockRejectedValueOnce(new Error('context exploded'));
    setTaskAnchor('t5', {});
    await requestAgentTurn(getIntegration(), anchors.get('t5')!, ref('a1', 'alpha'), turnOpts());
    const run = db.select().from(taskRuns).all()[0]!;
    expect(run.status).toBe('failed'); // not stuck in_flight until the sweep
  });
});

// ─── The drain ────────────────────────────────────────────────────────────────

describe('drainAgent', () => {
  it('dispatches queued work once capacity frees, fetching a fresh thread', async () => {
    const blocker = createRun({ agentId: 'a1', pageId: 'busy', taskPageId: 'busy', anchorKind: 'task', projectId: null, manageTaskStatus: true });
    setTaskAnchor('t10', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('t10')!, ref('a1', 'alpha'), turnOpts());
    expect(pendingCount('a1')).toBe(1);

    finalizeRun(blocker.id, 'done');
    await drainAgent('a1');

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(listThreadMock).toHaveBeenCalled(); // freshness: thread re-fetched at drain
    expect(pendingCount('a1')).toBe(0);
    const item = db.select().from(dispatchQueue).all()[0]!;
    expect(item.status).toBe('dispatched');
    // The dequeued run completed the task.
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 't10', 'Done');
  });

  it('keeps same-project items strictly sequential across a drain', async () => {
    const blocker = createRun({ agentId: 'a1', pageId: 'busy', taskPageId: 'busy', anchorKind: 'task', projectId: 'projA', manageTaskStatus: true });
    setTaskAnchor('s1', { projectId: 'projA' });
    setTaskAnchor('s2', { projectId: 'projA' });
    await requestAgentTurn(getIntegration(), anchors.get('s1')!, ref('a1', 'alpha'), turnOpts());
    await requestAgentTurn(getIntegration(), anchors.get('s2')!, ref('a1', 'alpha'), turnOpts());
    expect(pendingCount('a1')).toBe(2);

    finalizeRun(blocker.id, 'done');
    await drainAgent('a1');
    // The drain runs s1 → finishes (sync mock) → loops → runs s2. Both end up
    // dispatched, but each as its own sequential run.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const runs = db.select().from(taskRuns).where(eq(taskRuns.projectId, 'projA')).all();
    expect(runs.every(r => r.status === 'done')).toBe(true);
  });

  it('drops an item whose task went inert and releases its trigger key', async () => {
    createRun({ agentId: 'a1', pageId: 'busy', taskPageId: 'busy', anchorKind: 'task', projectId: null, manageTaskStatus: true });
    setTaskAnchor('t11', {});
    await requestAgentTurn(getIntegration(), anchors.get('t11')!, ref('a1', 'alpha'), turnOpts());
    db.insert(processedTriggers).values({ triggerKey: 'page:t11:a1', createdAt: Date.now() }).run();

    // A human parks the task while it waits.
    setTaskAnchor('t11', { status: 'Draft' });
    db.update(taskRuns).set({ status: 'done' }).where(eq(taskRuns.pageId, 'busy')).run();
    await drainAgent('a1');

    expect(dispatchMock).not.toHaveBeenCalled();
    const item = db.select().from(dispatchQueue).all()[0]!;
    expect(item.status).toBe('dropped');
    // The page key was released → flipping back to Backlog re-fires normally.
    const key = db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, 'page:t11:a1')).all();
    expect(key.length).toBe(0);
  });

  it('drops an item whose task got new unmet dependencies while queued', async () => {
    createRun({ agentId: 'a1', pageId: 'busy', taskPageId: 'busy', anchorKind: 'task', projectId: null, manageTaskStatus: true });
    setTaskAnchor('t12', {});
    await requestAgentTurn(getIntegration(), anchors.get('t12')!, ref('a1', 'alpha'), turnOpts());

    setTaskAnchor('t12', { deps: ['d-open'] });
    notionPages.set('d-open', { properties: taskProps({ status: 'In Progress' }) });
    db.update(taskRuns).set({ status: 'done' }).where(eq(taskRuns.pageId, 'busy')).run();
    await drainAgent('a1');

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(db.select().from(dispatchQueue).all()[0]!.status).toBe('dropped');
  });
});

// ─── Dependency release ───────────────────────────────────────────────────────

describe('releaseDependents', () => {
  it('dispatches a Backlog dependent (assigned) when its whole chain is Done', async () => {
    queryResults = [{ id: 'dep-task', properties: taskProps({ deps: ['done-task'], assignees: ['org-a1'] }) }];
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });
    setTaskAnchor('dep-task', { deps: ['done-task'], assignees: ['org-a1'] });

    await releaseDependents(getIntegration(), 'done-task');

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const run = db.select().from(taskRuns).where(eq(taskRuns.pageId, 'dep-task')).all()[0]!;
    expect(run.agentId).toBe('a1');
    expect(run.status).toBe('done');
    // The assignment is owned by this release — later edits must not double-fire.
    const key = db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, 'page:dep-task:a1')).all();
    expect(key.length).toBe(1);
  });

  it('is idempotent per (dependent, completed-dep) pair', async () => {
    queryResults = [{ id: 'dep-task', properties: taskProps({ deps: ['done-task'], assignees: ['org-a1'] }) }];
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });
    setTaskAnchor('dep-task', {});

    await releaseDependents(getIntegration(), 'done-task');
    await releaseDependents(getIntegration(), 'done-task');
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('holds a dependent that still has another open dependency', async () => {
    queryResults = [{ id: 'dep-task', properties: taskProps({ deps: ['done-task', 'open-task'], assignees: ['org-a1'] }) }];
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });
    notionPages.set('open-task', { properties: taskProps({ status: 'Backlog' }) });

    await releaseDependents(getIntegration(), 'done-task');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('skips non-Backlog dependents and recurring templates', async () => {
    queryResults = [
      { id: 'in-progress', properties: taskProps({ status: 'In Progress', deps: ['done-task'] }) },
      { id: 'template', properties: taskProps({ deps: ['done-task'], recurrence: 'Weekly' }) },
    ];
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });

    await releaseDependents(getIntegration(), 'done-task');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── Scheduler dependency gate ────────────────────────────────────────────────

describe('runScheduler — dependency hold', () => {
  it('holds a due task with unmet deps WITHOUT consuming its occurrence, then fires it', async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    queryResults = [{ id: 'sch-1', properties: taskProps({ deps: ['d-open'], assignees: ['org-a1'], scheduledFor: due, recurrence: 'None' }) }];
    notionPages.set('d-open', { properties: taskProps({ status: 'In Progress' }) });
    setTaskAnchor('sch-1', { deps: ['d-open'], assignees: ['org-a1'] });

    await runScheduler();
    expect(dispatchMock).not.toHaveBeenCalled();
    // Occurrence NOT consumed; only the hold note key exists.
    const keys = db.select().from(processedTriggers).where(like(processedTriggers.triggerKey, 'schedule%')).all();
    expect(keys.map(k => k.triggerKey)).toEqual([`schedule-dep-hold:sch-1:${due}`]);

    // The dependency completes → next poll fires the task.
    notionPages.set('d-open', { properties: taskProps({ status: 'Done' }) });
    await runScheduler();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const occ = db.select().from(processedTriggers)
      .where(and(eq(processedTriggers.triggerKey, `schedule:sch-1:${due}`)))
      .all();
    expect(occ.length).toBe(1);
  });
});

// ─── Async completion (Agent API /complete) ───────────────────────────────────

describe('finalizeAgentReport', () => {
  function inflightRun(pageId: string) {
    const { id } = createRun({ agentId: 'a1', pageId, taskPageId: pageId, anchorKind: 'task', projectId: null, manageTaskStatus: true });
    return db.select().from(taskRuns).where(eq(taskRuns.id, id)).all()[0]!;
  }
  const runStatus = (id: string) => db.select().from(taskRuns).where(eq(taskRuns.id, id)).all()[0]!.status;

  it('done with a summary → posts it, marks the task Done, frees the agent, finalizes done', async () => {
    setTaskAnchor('tb-done');
    const run = inflightRun('tb-done');
    await finalizeAgentReport(run, { status: 'done', summary: 'shipped the thing' });
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'tb-done', 'Done');
    expect(postCommentMock.mock.calls.some(c => String(c[2]).includes('shipped the thing'))).toBe(true);
    expect(setAgentStatusMock).toHaveBeenCalledWith('k', 'org-a1', 'Available');
    expect(runStatus(run.id)).toBe('done');
  });

  it('done with NO summary → still posts a visible completion comment', async () => {
    setTaskAnchor('tb-nosum');
    const run = inflightRun('tb-nosum');
    await finalizeAgentReport(run, { status: 'done' });
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'tb-nosum', 'Done');
    expect(postCommentMock.mock.calls.some(c => String(c[2]).includes('completed this task'))).toBe(true);
  });

  it('blocked → parks the task as Blocked with the need, never marks it Done', async () => {
    setTaskAnchor('tb-blocked');
    const run = inflightRun('tb-blocked');
    await finalizeAgentReport(run, { status: 'blocked', summary: 'need the onboarding doc' });
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'tb-blocked', 'Blocked');
    expect(setTaskStatusMock).not.toHaveBeenCalledWith('k', 'tb-blocked', 'Done');
    expect(postCommentMock.mock.calls.some(c =>
      String(c[2]).includes('blocked') && String(c[2]).includes('need the onboarding doc'))).toBe(true);
    expect(setAgentStatusMock).toHaveBeenCalledWith('k', 'org-a1', 'Available');
    expect(runStatus(run.id)).toBe('done'); // run closed → agent freed
  });

  it('failed → marks the task Failed and finalizes failed', async () => {
    setTaskAnchor('tb-failed');
    const run = inflightRun('tb-failed');
    await finalizeAgentReport(run, { status: 'failed', summary: 'broke' });
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'tb-failed', 'Failed');
    expect(runStatus(run.id)).toBe('failed');
  });
});

// ─── Load-aware triage roster ─────────────────────────────────────────────────

describe('triage — load-aware roster', () => {
  it('shows each candidate load and instructs the LLM to prefer less-loaded agents', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, supported: true, text: '{"decision":"ignore","agent":null,"confidence":0,"message":""}' });
    await triage({
      provider: 'anthropic', apiKey: 'k', model: 'm', kind: 'task', title: 'T', text: 'do it',
      candidates: [{ name: 'alpha', specialty: 'dev', capabilities: 'code', activeRuns: 2, queuedCount: 3, maxConcurrentRuns: 4 }],
    });
    const prompt = dispatchMock.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain('(load: 2 running, 3 queued / cap 4)');
    expect(prompt).toContain('prefer the less-loaded one');
  });
});
