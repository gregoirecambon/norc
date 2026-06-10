import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ─── Mocks (pattern of orchestrator-human.test.ts) ────────────────────────────

vi.mock('../adapters/index.js', () => ({
  dispatch: vi.fn(async () => ({ ok: true, supported: true, text: 'ok' })),
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
// The thread returned by listThreadComments — configurable per test.
let threadComments: Array<{ id: string; discussionId: string | null; plainText: string; authorId: string; richText: unknown[] }> = [];
vi.mock('../lib/notion-anchor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/notion-anchor.js')>(),
  resolveAnchor: vi.fn(async (_key: string, pageId: string) => {
    const a = anchors.get(pageId);
    if (!a) throw new Error(`Could not find page with ID: ${pageId} (404)`);
    return a;
  }),
  listThreadComments: vi.fn(async () => threadComments),
  collectBlockMentionPageIds: vi.fn(async () => []),
  readBlockText: vi.fn(async () => ''),
  userDisplayName: vi.fn(async () => 'User'),
  readPageMarkdown: vi.fn(async () => ''),
}));

vi.mock('../lib/notion-writeback.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/notion-writeback.js')>(),
  postComment: vi.fn(async () => ({ commentId: 'our-c1', discussionId: 'd-our-c1' })),
  postCommentReply: vi.fn(async () => ({ commentId: 'our-c2', discussionId: 'd-reply' })),
  postCommentMentioning: vi.fn(async () => ({ commentId: 'our-c3', discussionId: null })),
  postCommentReplyMentioning: vi.fn(async () => ({ commentId: 'our-c4', discussionId: null })),
  postCommentRich: vi.fn(async () => ({ commentId: 'our-c5', discussionId: null })),
  postCommentReplyRich: vi.fn(async () => ({ commentId: 'our-c6', discussionId: null })),
  appendBlocks: vi.fn(async () => undefined),
  setTaskStatus: vi.fn(async () => undefined),
  setTaskAssignee: vi.fn(async () => undefined),
  setTaskFields: vi.fn(async () => undefined),
  setAgentStatus: vi.fn(async () => undefined),
  touchLastActive: vi.fn(async () => undefined),
  createTaskPage: vi.fn(async () => ({ pageId: 'new-task', url: '' })),
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

const notionPages = new Map<string, Record<string, unknown>>();
let openTaskResults: Record<string, unknown>[] = [];
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
  notionQuery: vi.fn(async (_k: string, _db: string, body?: Record<string, unknown>) => {
    const filter = (body as { filter?: { or?: unknown[] } } | undefined)?.filter;
    if (filter?.or) return { results: openTaskResults, has_more: false }; // open-tasks snapshot query
    return { results: [], has_more: false };
  }),
}));

// ─── Real modules under test ──────────────────────────────────────────────────

import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue, notionIntegration, notionDatabases, processedTriggers, norcSettings, orchestratorComments, pendingSelfChanges } from '../db/schema.js';
import { processWebhookEvent } from '../lib/orchestrator.js';
import { clearOrgMemberCache } from '../lib/org-members.js';
import { findPendingByDiscussion } from '../lib/self-changes.js';
import { getNorcSettingsOrDefault } from '../lib/norc-settings.js';
import { dispatch } from '../adapters/index.js';
import { postComment, postCommentReply, setTaskAssignee } from '../lib/notion-writeback.js';

const dispatchMock = vi.mocked(dispatch);
const postCommentMock = vi.mocked(postComment);
const postReplyMock = vi.mocked(postCommentReply);
const setAssigneeMock = vi.mocked(setTaskAssignee);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NORC_PAGE = 'org-norc';
const rt = (text: string) => [{ plain_text: text }];

function taskProps(opts: { title?: string; status?: string; assignees?: string[] } = {}) {
  return {
    'Name': { type: 'title', title: rt(opts.title ?? 'a task') },
    'Status': { type: 'select', select: { name: opts.status ?? 'Backlog' } },
    'Depends On': { type: 'relation', relation: [] },
    'Assigned To': { type: 'relation', relation: (opts.assignees ?? []).map(id => ({ id })) },
  };
}

function setTaskAnchor(pageId: string, opts: Parameters<typeof taskProps>[0] = {}) {
  anchors.set(pageId, { kind: 'task', pageId, parentDatabaseId: 'tasks-db', page: { properties: taskProps({ title: pageId, ...opts }) } });
}

function addAgent(id: string, name: string) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'connected',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1, orgDbPageId: `org-${id}`,
  }).run();
}

/** A comment that @mentions NORC's Org DB page, placed in the thread store. */
function norcMentionComment(commentId: string, text: string, discussionId: string | null = null) {
  threadComments = [{
    id: commentId, discussionId, plainText: text, authorId: 'user-greg',
    richText: [
      { type: 'mention', mention: { type: 'page', page: { id: NORC_PAGE } }, plain_text: '@NORC' },
      { type: 'text', plain_text: ` ${text}` },
    ],
  }];
}

const commentEvent = (commentId: string, pageId: string) => ({
  type: 'comment.created',
  entity: { id: commentId, type: 'comment' },
  data: { page_id: pageId, parent: { id: pageId, type: 'page' } },
  authors: [{ id: 'user-greg', type: 'person' }],
});

const pageEvent = (pageId: string) => ({
  type: 'page.properties_updated',
  entity: { id: pageId, type: 'page' },
  authors: [{ id: 'user-greg', type: 'person' }],
});

const llmReturns = (decision: unknown) => {
  dispatchMock.mockImplementation(async (args: { adapterType: string }) =>
    args.adapterType === 'claude-api'
      ? { ok: true, supported: true, text: JSON.stringify(decision) }
      : { ok: true, supported: true, text: 'agent did it' });
};

const norcLLMCalls = () => dispatchMock.mock.calls.filter(c => (c[0] as { adapterType: string }).adapterType === 'claude-api');
const agentDispatches = () => dispatchMock.mock.calls.filter(c => (c[0] as { adapterType: string }).adapterType === 'http');

beforeAll(() => {
  runMigrations();
  db.insert(notionDatabases).values([
    { id: 'db1', kind: 'tasks', notionDatabaseId: 'tasks-db', title: 'Tasks', createdAt: Date.now() },
    { id: 'db2', kind: 'org', notionDatabaseId: 'org-db', title: 'Org', createdAt: Date.now() },
  ]).run();
});

beforeEach(() => {
  db.delete(dispatchQueue).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  db.delete(processedTriggers).run();
  db.delete(norcSettings).run();
  db.delete(orchestratorComments).run();
  db.delete(pendingSelfChanges).run();
  db.delete(notionIntegration).run();
  db.insert(notionIntegration).values({
    id: 'i1', apiKey: 'k', status: 'active', workspaceStatus: 'provisioned',
    norcOrgPageId: NORC_PAGE, createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  db.insert(norcSettings).values({
    id: 's1', orchestratorEnabled: true, orchestratorApiKey: 'llm-key',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  anchors.clear();
  notionPages.clear();
  threadComments = [];
  openTaskResults = [];
  clearOrgMemberCache();
  dispatchMock.mockReset();
  postCommentMock.mockClear();
  postReplyMock.mockClear();
  setAssigneeMock.mockClear();
});

// ─── @NORC chat ───────────────────────────────────────────────────────────────

describe('@NORC mention — internal turn', () => {
  it('answers via the internal handler: one LLM call, no adapter dispatch, no run row', async () => {
    setTaskAnchor('t-chat');
    norcMentionComment('cm-1', 'what is everyone working on?');
    llmReturns({ reply: 'alpha is shipping onboarding; nothing queued.', actions: [] });

    await processWebhookEvent(commentEvent('cm-1', 't-chat'));

    expect(norcLLMCalls()).toHaveLength(1);
    expect(agentDispatches()).toHaveLength(0);
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
    const posted = postCommentMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(posted).toContain('alpha is shipping onboarding');
    expect(posted).toContain('🧭 **NORC**');
  });

  it("NORC's own reply comment does not re-trigger anything (loop guard)", async () => {
    setTaskAnchor('t-loop');
    norcMentionComment('cm-2', 'hello');
    llmReturns({ reply: 'hi!', actions: [] });
    await processWebhookEvent(commentEvent('cm-2', 't-loop'));
    expect(norcLLMCalls()).toHaveLength(1);

    // The webhook for OUR posted comment ('our-c1', recorded in orchestratorComments).
    await processWebhookEvent(commentEvent('our-c1', 't-loop'));
    expect(norcLLMCalls()).toHaveLength(1); // unchanged — guarded
  });

  it('assign_task action: sets Assigned To and dispatches the agent', async () => {
    addAgent('a1', 'alpha');
    setTaskAnchor('t-target', { title: 'Fix the API' });
    setTaskAnchor('t-chat2');
    norcMentionComment('cm-3', 'give the API task to alpha');
    llmReturns({ reply: 'Assigning it now.', actions: [{ type: 'assign_task', taskPageId: 't-target', assignee: 'alpha' }] });

    await processWebhookEvent(commentEvent('cm-3', 't-chat2'));

    expect(setAssigneeMock).toHaveBeenCalledWith('k', 't-target', ['org-a1']);
    expect(agentDispatches()).toHaveLength(1);
    const run = db.select().from(taskRuns).all()[0]!;
    expect(run.agentId).toBe('a1');
    expect(run.pageId).toBe('t-target');
    const posted = postCommentMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(posted).toContain('✅ assigned "Fix the API" to @alpha');
  });

  it('a failing action becomes a visible ⚠️ line, not a dead turn', async () => {
    setTaskAnchor('t-chat3');
    norcMentionComment('cm-4', 'assign ghost-task to nobody');
    llmReturns({ reply: 'Trying.', actions: [{ type: 'assign_task', taskPageId: 'ghost-task', assignee: 'nobody' }] });

    await processWebhookEvent(commentEvent('cm-4', 't-chat3'));

    const posted = postCommentMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(posted).toContain('⚠️ assign_task failed');
  });
});

// ─── NORC assigned a task via the page event ─────────────────────────────────

describe('task assigned to NORC', () => {
  it('runs the internal turn (idempotent per page), never an adapter dispatch', async () => {
    setTaskAnchor('t-norc', { assignees: [NORC_PAGE] });
    llmReturns({ reply: 'I will triage this.', actions: [] });

    await processWebhookEvent(pageEvent('t-norc'));
    await processWebhookEvent(pageEvent('t-norc'));

    expect(norcLLMCalls()).toHaveLength(1); // second event deduped
    expect(agentDispatches()).toHaveLength(0);
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
  });
});

// ─── Self-change propose → approve ────────────────────────────────────────────

describe('self-change propose → approve', () => {
  async function propose() {
    setTaskAnchor('t-self');
    norcMentionComment('cm-5', 'raise your auto-route threshold to 0.9');
    llmReturns({
      reply: 'Proposing the change.',
      actions: [{ type: 'propose_self_change', kind: 'autoRouteThreshold', payload: { value: 0.9 }, rationale: 'fewer false routes' }],
    });
    await processWebhookEvent(commentEvent('cm-5', 't-self'));
  }

  it('parks the change pending with the proposal diff, nothing applied yet', async () => {
    await propose();
    const pending = findPendingByDiscussion('d-our-c1');
    expect(pending).not.toBeNull();
    expect(pending!.kind).toBe('autoRouteThreshold');
    expect(getNorcSettingsOrDefault().autoRouteThreshold).toBe(0.7); // unchanged
    const posted = postCommentMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(posted).toContain('proposed change to my own configuration');
    expect(posted).toContain('— after —');
    expect(posted).toContain('approve');
  });

  it('an "approve" reply in the thread applies the change and closes it', async () => {
    await propose();
    threadComments = [{ id: 'cm-approve', discussionId: 'd-our-c1', plainText: 'approve', authorId: 'user-greg', richText: rt('approve') }];

    await processWebhookEvent(commentEvent('cm-approve', 't-self'));

    expect(getNorcSettingsOrDefault().autoRouteThreshold).toBe(0.9);
    expect(findPendingByDiscussion('d-our-c1')).toBeNull(); // resolved
    const row = db.select().from(pendingSelfChanges).all()[0]!;
    expect(row.status).toBe('approved');
    expect(row.resolvedByUserId).toBe('user-greg');
    const replies = postReplyMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(replies).toContain('✅ Applied');
  });

  it('a "reject" reply discards without applying', async () => {
    await propose();
    threadComments = [{ id: 'cm-reject', discussionId: 'd-our-c1', plainText: 'reject', authorId: 'user-greg', richText: rt('reject') }];

    await processWebhookEvent(commentEvent('cm-reject', 't-self'));

    expect(getNorcSettingsOrDefault().autoRouteThreshold).toBe(0.7);
    expect(db.select().from(pendingSelfChanges).all()[0]!.status).toBe('rejected');
  });

  it('an unclear reply keeps the change pending and asks for an explicit verdict', async () => {
    await propose();
    threadComments = [{ id: 'cm-meh', discussionId: 'd-our-c1', plainText: 'hmm interesting', authorId: 'user-greg', richText: rt('hmm interesting') }];

    await processWebhookEvent(commentEvent('cm-meh', 't-self'));

    expect(findPendingByDiscussion('d-our-c1')).not.toBeNull(); // still pending
    expect(getNorcSettingsOrDefault().autoRouteThreshold).toBe(0.7);
    const replies = postReplyMock.mock.calls.map(c => String(c[2])).join('\n');
    expect(replies).toContain('**approve** or **reject**');
  });
});
