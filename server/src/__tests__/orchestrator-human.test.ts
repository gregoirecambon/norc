import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ─── Mocks: everything that talks to the network (pattern of orchestrator-dispatch) ──

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

const notionPages = new Map<string, Record<string, unknown>>();
// Dependent-task queries keyed by the completed task id (the relation filter),
// so a background releaseDependents chain can't see another test's fixtures.
const depQueries = new Map<string, Record<string, unknown>[]>();
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
    const filter = (body as { filter?: { relation?: { contains?: string }; select?: { equals?: string }; property?: string } } | undefined)?.filter;
    if (filter?.property === 'Type' && filter.select?.equals === 'Human') {
      return { results: humanQueryResults, has_more: false };
    }
    const contains = filter?.relation?.contains;
    return { results: (contains && depQueries.get(contains)) || [], has_more: false };
  }),
}));
// Org DB rows returned by the listHumans Type=Human query.
let humanQueryResults: Record<string, unknown>[] = [];

// ─── Real modules under test ──────────────────────────────────────────────────

import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue, notionIntegration, notionDatabases, processedTriggers, norcSettings } from '../db/schema.js';
import { processWebhookEvent, releaseDependents, dispatchScheduledTask } from '../lib/orchestrator.js';
import { clearOrgMemberCache } from '../lib/org-members.js';
import { dispatch } from '../adapters/index.js';
import { postCommentRich, setTaskStatus } from '../lib/notion-writeback.js';

const dispatchMock = vi.mocked(dispatch);
const postRichMock = vi.mocked(postCommentRich);
const setTaskStatusMock = vi.mocked(setTaskStatus);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_DB = 'org-db';

const rt = (text: string) => [{ plain_text: text }];

function taskProps(opts: { title?: string; status?: string; deps?: string[]; assignees?: string[] } = {}) {
  return {
    'Name': { type: 'title', title: rt(opts.title ?? 'a task') },
    'Status': { type: 'select', select: { name: opts.status ?? 'Backlog' } },
    'Depends On': { type: 'relation', relation: (opts.deps ?? []).map(id => ({ id })) },
    'Assigned To': { type: 'relation', relation: (opts.assignees ?? []).map(id => ({ id })) },
  };
}

function setTaskAnchor(pageId: string, opts: Parameters<typeof taskProps>[0] = {}) {
  anchors.set(pageId, { kind: 'task', pageId, parentDatabaseId: 'tasks-db', page: { properties: taskProps({ title: pageId, ...opts }) } });
}

/** A project page (row in the Projects DB). Optionally carries an explicit
 * @-mention of an agent in its title, and/or a structural relation to one
 * (e.g. a "Team" relation — reference data, not a command). */
function projectProps(opts: { title?: string; mentionOrg?: string; relationOrg?: string } = {}) {
  const title = opts.mentionOrg
    ? [{ type: 'mention', mention: { type: 'page', page: { id: opts.mentionOrg } }, plain_text: '@agent' }]
    : rt(opts.title ?? 'a project');
  return {
    'Name': { type: 'title', title },
    ...(opts.relationOrg ? { 'Team': { type: 'relation', relation: [{ id: opts.relationOrg }] } } : {}),
  };
}

function setProjectAnchor(pageId: string, opts: Parameters<typeof projectProps>[0] = {}) {
  anchors.set(pageId, { kind: 'project', pageId, parentDatabaseId: 'projects-db', page: { properties: projectProps(opts) } });
}

/** Register a human's Org DB page so resolveOrgMembers finds it via notionGet. */
function addHumanPage(pageId: string, name = 'Greg', ownerUserId: string | null = 'user-greg') {
  notionPages.set(pageId, {
    id: pageId,
    parent: { type: 'database_id', database_id: ORG_DB },
    properties: {
      'Name': { type: 'title', title: rt(name) },
      'Type': { type: 'select', select: { name: 'Human' } },
      'Specialty': { type: 'rich_text', rich_text: rt('partnerships') },
      'Owner': { type: 'people', people: ownerUserId ? [{ id: ownerUserId }] : [] },
    },
  });
}

function addAgent(id: string, name: string) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'connected',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1, orgDbPageId: `org-${id}`,
  }).run();
}

function enableTriage() {
  db.insert(norcSettings).values({
    id: 's1', orchestratorEnabled: true, orchestratorApiKey: 'llm-key',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
}

function getIntegration() {
  return db.select().from(notionIntegration).all()[0]!;
}

const pageEvent = (pageId: string) => ({
  type: 'page.properties_updated',
  entity: { id: pageId, type: 'page' },
  authors: [{ id: 'user-greg', type: 'person' }],
});

const commentEvent = (commentId: string, pageId: string) => ({
  type: 'comment.created',
  entity: { id: commentId, type: 'comment' },
  data: { page_id: pageId, parent: { id: pageId, type: 'page' } },
  authors: [{ id: 'user-greg', type: 'person' }],
});

/** Flattened text of every rich comment posted so far. */
function richText(): string {
  return postRichMock.mock.calls
    .map(c => (c[2] as unknown[]).map(s => (typeof s === 'string' ? s : JSON.stringify(s))).join(''))
    .join('\n');
}

beforeAll(() => {
  runMigrations();
  db.insert(notionIntegration).values({
    id: 'i1', apiKey: 'k', status: 'active', workspaceStatus: 'provisioned',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run();
  db.insert(notionDatabases).values([
    { id: 'db1', kind: 'tasks', notionDatabaseId: 'tasks-db', title: 'Tasks', createdAt: Date.now() },
    { id: 'db2', kind: 'org', notionDatabaseId: ORG_DB, title: 'Org', createdAt: Date.now() },
  ]).run();
});

beforeEach(() => {
  db.delete(dispatchQueue).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  db.delete(processedTriggers).run();
  db.delete(norcSettings).run();
  anchors.clear();
  notionPages.clear();
  depQueries.clear();
  humanQueryResults = [];
  clearOrgMemberCache();
  dispatchMock.mockClear();
  dispatchMock.mockResolvedValue({ ok: true, supported: true, text: 'done by agent' });
  postRichMock.mockClear();
  setTaskStatusMock.mockClear();
});

// ─── Assignment to a human ────────────────────────────────────────────────────

describe('page event — task assigned to a human', () => {
  it('notifies the human (with @user mention) and never dispatches', async () => {
    addHumanPage('org-greg');
    setTaskAnchor('t-h', { assignees: ['org-greg'] });

    await processWebhookEvent(pageEvent('t-h'));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(db.select().from(taskRuns).all()).toHaveLength(0); // no run minted
    expect(setTaskStatusMock).not.toHaveBeenCalled();          // no status write
    expect(postRichMock).toHaveBeenCalledTimes(1);
    const segs = postRichMock.mock.calls[0]![2] as unknown[];
    expect(segs).toContainEqual({ userId: 'user-greg' });      // Owner notification
    expect(segs).toContainEqual({ pageId: 'org-greg' });       // member page mention
    expect(richText()).toContain('Done');
  });

  it('is idempotent across repeated page edits', async () => {
    addHumanPage('org-greg');
    setTaskAnchor('t-h2', { assignees: ['org-greg'] });
    await processWebhookEvent(pageEvent('t-h2'));
    await processWebhookEvent(pageEvent('t-h2'));
    expect(postRichMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a page mention + Owner hint when the member has no Owner', async () => {
    addHumanPage('org-greg', 'Greg', null);
    setTaskAnchor('t-h3', { assignees: ['org-greg'] });
    await processWebhookEvent(pageEvent('t-h3'));
    const segs = postRichMock.mock.calls[0]![2] as unknown[];
    expect(segs.some(s => typeof s === 'object' && s !== null && 'userId' in s)).toBe(false);
    expect(richText()).toContain('Owner');
  });

  it('mixed human + agent assignment: agent dispatched, human notified once', async () => {
    addAgent('a1', 'alpha');
    addHumanPage('org-greg');
    setTaskAnchor('t-mix', { assignees: ['org-a1', 'org-greg'] });

    await processWebhookEvent(pageEvent('t-mix'));

    expect(dispatchMock).toHaveBeenCalledTimes(1); // the agent's turn
    expect(postRichMock).toHaveBeenCalledTimes(1); // the human's note
  });
});

// ─── Triage stays away from human tasks ───────────────────────────────────────

describe('triage guard — human-assigned tasks', () => {
  it('a no-mention comment on a human task does NOT trigger triage', async () => {
    enableTriage();
    addHumanPage('org-greg');
    setTaskAnchor('t-conv', { assignees: ['org-greg'] });

    await processWebhookEvent(commentEvent('cm-1', 't-conv'));

    expect(dispatchMock).not.toHaveBeenCalled(); // triage LLM never called
  });

  it('contrast: the same comment on an unassigned task DOES reach triage', async () => {
    enableTriage();
    addAgent('a1', 'alpha');
    setTaskAnchor('t-free', {});
    dispatchMock.mockResolvedValue({ ok: true, supported: true, text: '{"decision":"ignore","agent":null,"confidence":0,"message":"who?"}' });

    await processWebhookEvent(commentEvent('cm-2', 't-free'));

    expect(dispatchMock).toHaveBeenCalled(); // the triage LLM call
  });
});

// ─── Triage stays away from project pages (reference data, not a work surface) ──

describe('triage guard — project pages', () => {
  it('a project edit with no @mention does NOT triage or dispatch', async () => {
    enableTriage();
    addAgent('a1', 'alpha');
    setProjectAnchor('p-edit');

    await processWebhookEvent(pageEvent('p-edit'));

    expect(dispatchMock).not.toHaveBeenCalled();          // no triage LLM, no agent turn
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
  });

  it('an agent in a project RELATION (structural) does NOT dispatch — only a clear @mention counts', async () => {
    enableTriage();
    addAgent('a1', 'alpha');
    setProjectAnchor('p-rel', { relationOrg: 'org-a1' });

    await processWebhookEvent(pageEvent('p-rel'));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
  });

  it('contrast: an explicit @mention of an agent on a project page DOES dispatch', async () => {
    enableTriage();
    addAgent('a1', 'alpha');
    setProjectAnchor('p-mention', { mentionOrg: 'org-a1' });

    await processWebhookEvent(pageEvent('p-mention'));

    expect(dispatchMock).toHaveBeenCalledTimes(1);        // the agent's turn
    expect((dispatchMock.mock.calls[0]![0] as { adapterType: string }).adapterType).toBe('http');
  });

  it('a no-mention comment on a project page does NOT trigger triage', async () => {
    enableTriage();
    addAgent('a1', 'alpha');
    setProjectAnchor('p-comment');

    await processWebhookEvent(commentEvent('cm-proj', 'p-comment'));

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── Triage suggests a human as last resort ───────────────────────────────────

describe('triage — humans as last-resort candidates', () => {
  it('suggests the human (page mention + Owner cc) and never assigns or dispatches an agent turn', async () => {
    enableTriage();
    addHumanPage('org-greg');                                  // resolvable Org DB page
    humanQueryResults = [notionPages.get('org-greg')!];        // listHumans roster
    setTaskAnchor('t-lease', { title: 'Sign the office lease' });
    dispatchMock.mockResolvedValue({
      ok: true, supported: true,
      text: '{"decision":"suggest","agent":"Greg","confidence":0.4,"message":"Only Greg can sign contracts."}',
    });

    await processWebhookEvent(commentEvent('cm-lease', 't-lease'));

    // Exactly one dispatch — the triage LLM itself (claude-api), no agent turn.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect((dispatchMock.mock.calls[0]![0] as { adapterType: string }).adapterType).toBe('claude-api');
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
    // The prompt carried the human roster section.
    expect((dispatchMock.mock.calls[0]![0] as { prompt: string }).prompt).toContain('HUMAN TEAM MEMBERS (LAST RESORT ONLY):');
    // The suggestion mentions the member page and asks for confirmation.
    const segs = postRichMock.mock.calls[0]![2] as unknown[];
    expect(segs).toContainEqual({ pageId: 'org-greg' });
    expect(richText()).toContain('Assigned To');
  });

  it('a "route" verdict on a human still only suggests (no dispatch, no assignment)', async () => {
    enableTriage();
    addHumanPage('org-greg');
    humanQueryResults = [notionPages.get('org-greg')!];
    setTaskAnchor('t-route-h', {});
    dispatchMock.mockResolvedValue({
      ok: true, supported: true,
      text: '{"decision":"route","agent":"Greg","confidence":0.95,"message":"routing to Greg"}',
    });

    await processWebhookEvent(commentEvent('cm-route-h', 't-route-h'));

    expect(dispatchMock).toHaveBeenCalledTimes(1); // triage LLM only
    expect(db.select().from(taskRuns).all()).toHaveLength(0);
    expect(postRichMock).toHaveBeenCalledTimes(1);
    expect(richText()).toContain('Assigned To'); // suggestion, not an auto-route
  });
});

// ─── Dependency release ───────────────────────────────────────────────────────

describe('releaseDependents — human assignees', () => {
  it('notifies a human-assigned dependent instead of triaging it', async () => {
    enableTriage();
    addHumanPage('org-greg');
    depQueries.set('done-task', [{ id: 'dep-h', properties: taskProps({ deps: ['done-task'], assignees: ['org-greg'] }) }]);
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });
    setTaskAnchor('dep-h', { deps: ['done-task'], assignees: ['org-greg'] });

    await releaseDependents(getIntegration(), 'done-task');

    expect(dispatchMock).not.toHaveBeenCalled(); // no agent turn, no triage LLM
    expect(postRichMock).toHaveBeenCalledTimes(1);
    expect(richText()).toContain('unblocked');
  });

  it('release is idempotent per (dependent, completed-dep) pair', async () => {
    addHumanPage('org-greg');
    depQueries.set('done-task', [{ id: 'dep-h2', properties: taskProps({ deps: ['done-task'], assignees: ['org-greg'] }) }]);
    notionPages.set('done-task', { properties: taskProps({ status: 'Done' }) });
    setTaskAnchor('dep-h2', { deps: ['done-task'], assignees: ['org-greg'] });

    await releaseDependents(getIntegration(), 'done-task');
    await releaseDependents(getIntegration(), 'done-task');
    expect(postRichMock).toHaveBeenCalledTimes(1);
  });

  it('human marking a task Done (webhook) releases an agent-assigned dependent', async () => {
    addAgent('a1', 'alpha');
    setTaskAnchor('done-by-human', { status: 'Done' });
    depQueries.set('done-by-human', [{ id: 'dep-a', properties: taskProps({ deps: ['done-by-human'], assignees: ['org-a1'] }) }]);
    notionPages.set('done-by-human', { properties: taskProps({ status: 'Done' }) });
    setTaskAnchor('dep-a', { deps: ['done-by-human'], assignees: ['org-a1'] });

    await processWebhookEvent(pageEvent('done-by-human'));

    // The release runs in the background (fire-and-forget off the webhook) —
    // wait for the dependent's run to fully finalize so nothing bleeds over.
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1); // dependent dispatched to alpha
      expect(db.select().from(taskRuns).all()[0]!.status).toBe('done');
    });
  });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

describe('dispatchScheduledTask — human assignees', () => {
  it('notifies the human (per occurrence) instead of dispatching or triaging', async () => {
    enableTriage();
    addHumanPage('org-greg');
    setTaskAnchor('sch-h', { assignees: ['org-greg'] });

    await dispatchScheduledTask(getIntegration(), 'sch-h', 'scheduled task', 'occ-1');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(postRichMock).toHaveBeenCalledTimes(1);
    expect(richText()).toContain('due');

    // A NEW occurrence re-notifies; the same one doesn't.
    await dispatchScheduledTask(getIntegration(), 'sch-h', 'scheduled task', 'occ-1');
    expect(postRichMock).toHaveBeenCalledTimes(1);
    await dispatchScheduledTask(getIntegration(), 'sch-h', 'scheduled task', 'occ-2');
    expect(postRichMock).toHaveBeenCalledTimes(2);
  });
});
