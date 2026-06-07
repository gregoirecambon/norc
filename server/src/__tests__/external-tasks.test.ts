// Out-of-band task intake (the "Slack rule") — list, duplicate gate, create,
// claim, and the priority queue handoff. Mirrors the orchestrator-dispatch
// mocking style: network modules mocked, DB + queue + similarity real.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ─── Mocks: everything that talks to the network ─────────────────────────────

vi.mock('../adapters/index.js', () => ({
  dispatch: vi.fn(async () => ({ ok: true, supported: true, text: 'done by agent' })),
  dispatchSupported: vi.fn(() => true),
  pingAgent: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
  notifySkillUpdate: vi.fn(async () => ({ pushed: false })),
}));

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

// Partial mock: pure helpers (toRichText, used by notion-blocks-md) stay real.
vi.mock('../lib/notion-writeback.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/notion-writeback.js')>(),
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
  createTaskPage: vi.fn(async () => ({ pageId: 'new-task', url: 'https://notion.so/new-task' })),
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

// Database queries steered per databaseId (projects roster + open tasks).
const queryByDb = new Map<string, Record<string, unknown>[]>();
vi.mock('../lib/notion-client.js', () => ({
  NOTION_API: 'https://api.notion.com/v1',
  NOTION_VERSION: '2022-06-28',
  headers: () => ({}),
  notionGet: vi.fn(async () => ({})),
  notionPost: vi.fn(async () => ({})),
  notionPatch: vi.fn(async () => ({})),
  notionQuery: vi.fn(async (_k: string, databaseId: string) =>
    ({ results: queryByDb.get(databaseId) ?? [], has_more: false })),
}));

// LLM judge controllable per test; everything else in the module stays real.
vi.mock('../lib/orchestrator-agent.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/orchestrator-agent.js')>(),
  judgeTaskSimilarity: vi.fn(async () => []),
}));

// ─── Real modules under test ──────────────────────────────────────────────────

import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue, notionIntegration, notionDatabases, processedTriggers, norcSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { listExternalTasks, intakeExternalTask } from '../lib/external-tasks.js';
import { upsertNorcSettings } from '../lib/norc-settings.js';
import { judgeTaskSimilarity } from '../lib/orchestrator-agent.js';
import { createRun } from '../lib/runs.js';
import { pendingItems, enqueueTurn } from '../lib/dispatch-queue.js';
import { createTaskPage, setTaskStatus, setTaskAssignee, setAgentStatus } from '../lib/notion-writeback.js';

const judgeMock = vi.mocked(judgeTaskSimilarity);
const createTaskPageMock = vi.mocked(createTaskPage);
const setTaskStatusMock = vi.mocked(setTaskStatus);
const setTaskAssigneeMock = vi.mocked(setTaskAssignee);
const setAgentStatusMock = vi.mocked(setAgentStatus);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function projectRow(id: string, name: string) {
  return { id, url: `https://notion.so/${id}`, properties: { 'Name': { type: 'title', title: [{ plain_text: name }] } } };
}

function taskRow(id: string, title: string, status = 'Backlog', assignees: string[] = []) {
  return {
    id, url: `https://notion.so/${id}`,
    properties: {
      'Name': { type: 'title', title: [{ plain_text: title }] },
      'Status': { type: 'select', select: { name: status } },
      'Assigned To': { type: 'relation', relation: assignees.map(a => ({ id: a })) },
    },
  };
}

function setTaskAnchor(pageId: string, opts: { title?: string; status?: string; projectId?: string; assignees?: string[] } = {}) {
  anchors.set(pageId, {
    kind: 'task', pageId, parentDatabaseId: 'tasks-db',
    page: {
      url: `https://notion.so/${pageId}`,
      properties: {
        'Name': { type: 'title', title: [{ plain_text: opts.title ?? pageId }] },
        'Status': { type: 'select', select: opts.status === '' ? null : { name: opts.status ?? 'Backlog' } },
        ...(opts.projectId ? { 'Project': { type: 'relation', relation: [{ id: opts.projectId }] } } : {}),
        'Assigned To': { type: 'relation', relation: (opts.assignees ?? []).map(id => ({ id })) },
      },
    },
  });
}

function addAgent(id: string, name: string, opts: { maxConcurrentRuns?: number; orgDbPageId?: string | null } = {}) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'connected',
    registeredAt: Date.now(), metadata: '{}',
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
    orgDbPageId: opts.orgDbPageId === undefined ? `org-${id}` : opts.orgDbPageId,
  }).run();
}

function agentRow(id: string) {
  return db.select().from(agents).where(eq(agents.id, id)).all()[0]!;
}

function hasTriggerKey(key: string): boolean {
  return db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, key)).all().length === 1;
}

beforeAll(() => {
  runMigrations();
  db.insert(notionIntegration).values({
    id: 'i1', apiKey: 'k', status: 'active', workspaceStatus: 'provisioned',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  db.insert(notionDatabases).values([
    { id: 'db1', kind: 'tasks', notionDatabaseId: 'tasks-db', title: 'Tasks', createdAt: Date.now() },
    { id: 'db2', kind: 'projects', notionDatabaseId: 'projects-db', title: 'Projects', createdAt: Date.now() },
  ]).run();
});

beforeEach(() => {
  db.delete(dispatchQueue).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  db.delete(processedTriggers).run();
  db.delete(norcSettings).run();
  anchors.clear();
  queryByDb.clear();
  queryByDb.set('projects-db', [projectRow('proj-a', 'Site v2')]);
  queryByDb.set('tasks-db', []);
  judgeMock.mockClear();
  judgeMock.mockResolvedValue([]);
  createTaskPageMock.mockClear();
  setTaskStatusMock.mockClear();
  setTaskAssigneeMock.mockClear();
  setAgentStatusMock.mockClear();
  addAgent('a1', 'alpha');
});

// ─── GET: the pre-check listing ───────────────────────────────────────────────

describe('listExternalTasks', () => {
  it('resolves a project by name (case-insensitive) and lists its open tasks', async () => {
    queryByDb.set('tasks-db', [taskRow('t1', 'Fix login bug', 'Backlog', ['org-a1'])]);
    const out = await listExternalTasks('site V2');
    expect(out).toMatchObject({
      outcome: 'ok',
      project: { id: 'proj-a', name: 'Site v2' },
      tasks: [{ id: 't1', title: 'Fix login bug', status: 'Backlog', assignedTo: ['alpha'] }],
    });
  });

  it('returns the project roster when the name does not resolve', async () => {
    const out = await listExternalTasks('No Such Project');
    expect(out).toMatchObject({ outcome: 'project_not_found', projects: [{ name: 'Site v2' }] });
  });

  it('ranks tasks by similarity to q', async () => {
    queryByDb.set('tasks-db', [
      taskRow('t1', 'Write pricing page copy'),
      taskRow('t2', 'Fix login bug'),
    ]);
    const out = await listExternalTasks(undefined, 'login bug on iOS');
    if (out.outcome !== 'ok') throw new Error('expected ok');
    expect(out.tasks[0]).toMatchObject({ id: 't2' });
    expect(out.tasks[0]!.score).toBeGreaterThan(out.tasks[1]!.score!);
  });
});

// ─── POST: validation outcomes ────────────────────────────────────────────────

describe('intakeExternalTask — validation', () => {
  it('requires a title on the create path', async () => {
    expect(await intakeExternalTask(agentRow('a1'), {})).toEqual({ outcome: 'title_required' });
  });

  it('refuses an agent that is not in the Org DB', async () => {
    addAgent('a2', 'beta', { orgDbPageId: null });
    expect(await intakeExternalTask(agentRow('a2'), { title: 'X' })).toEqual({ outcome: 'agent_not_in_org' });
  });

  it('returns the roster when the project does not resolve', async () => {
    const out = await intakeExternalTask(agentRow('a1'), { title: 'X', project: 'nope' });
    expect(out).toMatchObject({ outcome: 'project_not_found', projects: [{ id: 'proj-a' }] });
  });
});

// ─── POST: the duplicate gate ─────────────────────────────────────────────────

describe('intakeExternalTask — duplicate gate', () => {
  it('blocks an exact-duplicate title (heuristic, no LLM configured)', async () => {
    queryByDb.set('tasks-db', [taskRow('t1', 'Fix login bug', 'In Progress', ['org-a1'])]);
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Fix the login bug!', project: 'Site v2' });
    expect(out).toMatchObject({
      outcome: 'similar',
      candidates: [{ id: 't1', title: 'Fix login bug', status: 'In Progress', score: 1, assignedTo: ['alpha'] }],
    });
    expect(createTaskPageMock).not.toHaveBeenCalled();
  });

  it('force:true bypasses the gate', async () => {
    queryByDb.set('tasks-db', [taskRow('t1', 'Fix login bug')]);
    setTaskAnchor('new-task', { title: 'Fix the login bug!', projectId: 'proj-a' });
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Fix the login bug!', project: 'Site v2', force: true });
    expect(out).toMatchObject({ outcome: 'created' });
  });

  it('asks the LLM judge for judge-zone candidates and blocks on its verdict', async () => {
    upsertNorcSettings({ orchestratorApiKey: 'llm-key' });
    queryByDb.set('tasks-db', [taskRow('t1', 'Review pricing strategy options Europe')]);
    judgeMock.mockResolvedValueOnce([{ index: 0, reason: 'same pricing work' }]);
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Prepare Q3 pricing strategy deck' });
    expect(judgeMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      outcome: 'similar',
      candidates: [{ id: 't1', reason: 'same pricing work' }],
    });
  });

  it('creates when the judge clears all candidates (judge-zone score is not blocking)', async () => {
    upsertNorcSettings({ orchestratorApiKey: 'llm-key' });
    queryByDb.set('tasks-db', [taskRow('t1', 'Review pricing strategy options Europe')]);
    judgeMock.mockResolvedValueOnce([]); // judge: different work
    setTaskAnchor('new-task', { title: 'Prepare Q3 pricing strategy deck' });
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Prepare Q3 pricing strategy deck' });
    expect(out).toMatchObject({ outcome: 'created' });
  });

  it('an exact title match blocks even when the judge disagrees', async () => {
    upsertNorcSettings({ orchestratorApiKey: 'llm-key' });
    queryByDb.set('tasks-db', [taskRow('t1', 'Fix login bug')]);
    judgeMock.mockResolvedValueOnce([]);
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Fix login bug' });
    expect(out).toMatchObject({ outcome: 'similar', candidates: [{ id: 't1', score: 1 }] });
  });

  it('falls back to the heuristic when the judge is unavailable', async () => {
    upsertNorcSettings({ orchestratorApiKey: 'llm-key' });
    queryByDb.set('tasks-db', [taskRow('t1', 'Review pricing strategy options Europe')]);
    judgeMock.mockResolvedValueOnce(null); // LLM down
    setTaskAnchor('new-task', { title: 'Prepare Q3 pricing strategy deck' });
    // Heuristic score 0.4 < blockAt 0.5 → allowed through.
    const out = await intakeExternalTask(agentRow('a1'), { title: 'Prepare Q3 pricing strategy deck' });
    expect(out).toMatchObject({ outcome: 'created' });
  });
});

// ─── POST: create → self-claimed run / priority queue ─────────────────────────

describe('intakeExternalTask — create + claim mechanics', () => {
  it('creates, assigns, mints a self-claimed run, and pre-marks both trigger keys', async () => {
    setTaskAnchor('new-task', { title: 'Ship the launch email', projectId: 'proj-a' });
    const out = await intakeExternalTask(agentRow('a1'), {
      title: 'Ship the launch email', description: 'User asked in Slack', project: 'Site v2', source: 'slack',
    });
    expect(out).toMatchObject({
      outcome: 'created',
      task: { id: 'new-task', url: 'https://notion.so/new-task' },
      claim: { mode: 'dispatched' },
    });

    // Created with the project + self-assignment.
    expect(createTaskPageMock).toHaveBeenCalledWith('k', 'tasks-db', expect.objectContaining({
      title: 'Ship the launch email', projectId: 'proj-a', assigneeIds: ['org-a1'],
    }));
    // Self-claimed run is live: work lane, in flight, no adapter dispatch.
    const run = db.select().from(taskRuns).all()[0]!;
    expect(run).toMatchObject({ pageId: 'new-task', taskPageId: 'new-task', status: 'in_flight', lane: 'work', projectId: 'proj-a' });
    // Write-first Notion state + webhook echo guards.
    expect(setAgentStatusMock).toHaveBeenCalledWith('k', 'org-a1', 'Busy');
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'new-task', 'In Progress');
    expect(setTaskAssigneeMock).toHaveBeenCalledWith('k', 'new-task', ['org-a1']);
    expect(hasTriggerKey('triage:new-task')).toBe(true);
    expect(hasTriggerKey('page:new-task:a1')).toBe(true);
  });

  it('priority-queues (Status Queued, front position) when the agent is busy on the project', async () => {
    createRun({ agentId: 'a1', pageId: 'busy', taskPageId: 'busy', anchorKind: 'task', projectId: 'proj-a', manageTaskStatus: true });
    // Pre-existing normal queued work for the same agent on another project.
    enqueueTurn({ agentId: 'a1', pageId: 'other', taskPageId: 'other', projectId: 'proj-b', anchorKind: 'task', title: 'other', payload: { request: 'x', manageTaskStatus: true, how: 'assignment' } });
    setTaskAnchor('new-task', { title: 'Ship the launch email', projectId: 'proj-a' });

    const out = await intakeExternalTask(agentRow('a1'), { title: 'Ship the launch email', project: 'Site v2', source: 'slack' });
    expect(out).toMatchObject({ outcome: 'created', claim: { mode: 'queued', position: 1, pending: 2 } });

    const items = pendingItems('a1');
    expect(items[0]).toMatchObject({ pageId: 'new-task', priority: 1 });
    expect(setTaskStatusMock).toHaveBeenCalledWith('k', 'new-task', 'Queued');
    // No run minted — the queued item drains through the normal adapter path.
    expect(db.select().from(taskRuns).where(eq(taskRuns.pageId, 'new-task')).all()).toHaveLength(0);
  });
});

// ─── POST: claiming an existing task ──────────────────────────────────────────

describe('intakeExternalTask — claim path', () => {
  it('claims a Backlog task and drops its stale queued siblings', async () => {
    setTaskAnchor('t9', { title: 'Old backlog task', status: 'Backlog', projectId: 'proj-a' });
    enqueueTurn({ agentId: 'a1', pageId: 't9', taskPageId: 't9', projectId: 'proj-a', anchorKind: 'task', title: 'Old backlog task', payload: { request: 'x', manageTaskStatus: true, how: 'assignment' } });

    const out = await intakeExternalTask(agentRow('a1'), { existingTaskPageId: 't9', source: 'slack' });
    expect(out).toMatchObject({
      outcome: 'claimed',
      task: { id: 't9', title: 'Old backlog task' },
      claim: { mode: 'dispatched' },
    });
    expect(pendingItems('a1')).toHaveLength(0); // stale sibling superseded
    expect(db.select().from(taskRuns).all()[0]).toMatchObject({ pageId: 't9', status: 'in_flight' });
    expect(hasTriggerKey('page:t9:a1')).toBe(true);
  });

  it('refuses an In Progress task, naming who is on it', async () => {
    addAgent('a2', 'beta');
    setTaskAnchor('t9', { status: 'In Progress', assignees: ['org-a2'] });
    const out = await intakeExternalTask(agentRow('a1'), { existingTaskPageId: 't9' });
    expect(out).toEqual({ outcome: 'task_already_active', assignedTo: ['beta'] });
  });

  it('refuses a closed task', async () => {
    setTaskAnchor('t9', { status: 'Done' });
    expect(await intakeExternalTask(agentRow('a1'), { existingTaskPageId: 't9' }))
      .toEqual({ outcome: 'task_closed', status: 'Done' });
  });

  it('distinguishes not-found from not-a-task', async () => {
    expect(await intakeExternalTask(agentRow('a1'), { existingTaskPageId: 'ghost' }))
      .toEqual({ outcome: 'task_not_found' });
    anchors.set('free-page', { kind: 'page', pageId: 'free-page', parentDatabaseId: null, page: { properties: {} } });
    expect(await intakeExternalTask(agentRow('a1'), { existingTaskPageId: 'free-page' }))
      .toEqual({ outcome: 'not_a_task' });
  });
});
