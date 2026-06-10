import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/notion-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notion-client.js')>()),
  notionGet: vi.fn(),
  notionQuery: vi.fn(),
}));
vi.mock('../lib/notion-anchor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notion-anchor.js')>()),
  readPageMarkdown: vi.fn(),
}));

import { runMigrations, db } from '../db/client.js';
import { notionDatabases } from '../db/schema.js';
import { notionGet, notionQuery } from '../lib/notion-client.js';
import { readPageMarkdown } from '../lib/notion-anchor.js';
import { parseOrgMember, resolveOrgMembers, listHumans, clearOrgMemberCache } from '../lib/org-members.js';

const ORG_DB_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

const rt = (text: string) => [{ plain_text: text }];

function humanProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Name': { type: 'title', title: rt('Greg') },
    'Type': { type: 'select', select: { name: 'Human' } },
    'Specialty': { type: 'rich_text', rich_text: rt('product, golf domain') },
    'Capabilities': { type: 'multi_select', multi_select: [{ name: 'review' }, { name: 'design' }] },
    'Status': { type: 'select', select: { name: 'Available' } },
    'Owner': { type: 'people', people: [{ id: 'user-greg' }] },
    ...over,
  };
}

function orgPage(id: string, props: Record<string, unknown>): Record<string, unknown> {
  return { id, parent: { type: 'database_id', database_id: ORG_DB_ID }, properties: props };
}

beforeAll(() => { runMigrations(); });

beforeEach(() => {
  clearOrgMemberCache();
  vi.mocked(notionGet).mockReset();
  vi.mocked(notionQuery).mockReset();
  vi.mocked(readPageMarkdown).mockReset();
  db.delete(notionDatabases).run();
  db.insert(notionDatabases).values({
    id: 'row-org', kind: 'org', notionDatabaseId: ORG_DB_ID, title: 'Org', createdAt: Date.now(),
  }).run();
});

describe('parseOrgMember', () => {
  it('parses a Human page with owner, specialty, and multi_select capabilities', () => {
    const m = parseOrgMember('page-1', humanProps());
    expect(m).toMatchObject({
      pageId: 'page-1', name: 'Greg', type: 'human',
      ownerUserIds: ['user-greg'],
      specialty: 'product, golf domain',
      capabilities: 'review, design',
      status: 'Available',
    });
  });

  it('maps the Type select to the member type, unknown otherwise', () => {
    expect(parseOrgMember('p', humanProps({ 'Type': { type: 'select', select: { name: 'AI Agent' } } })).type).toBe('ai_agent');
    expect(parseOrgMember('p', humanProps({ 'Type': { type: 'select', select: { name: 'Orchestrator' } } })).type).toBe('orchestrator');
    expect(parseOrgMember('p', humanProps({ 'Type': { type: 'select', select: null } })).type).toBe('unknown');
    expect(parseOrgMember('p', null).type).toBe('unknown');
  });
});

describe('resolveOrgMembers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('keeps Org DB members and drops pages from other databases', async () => {
    vi.mocked(notionGet).mockImplementation(async (_key, path) => {
      if (path === '/pages/human-1') return orgPage('human-1', humanProps());
      return { id: 'task-1', parent: { type: 'database_id', database_id: 'some-other-db' }, properties: {} };
    });
    const out = await resolveOrgMembers('key', ['human-1', 'task-1']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Greg', type: 'human' });
  });

  it('negative-caches non-Org pages and caches members within the TTL', async () => {
    vi.mocked(notionGet).mockImplementation(async (_key, path) =>
      path === '/pages/human-1'
        ? orgPage('human-1', humanProps())
        : { id: 'other', parent: { database_id: 'not-org' }, properties: {} });
    await resolveOrgMembers('key', ['human-1', 'other']);
    await resolveOrgMembers('key', ['human-1', 'other']);
    expect(notionGet).toHaveBeenCalledTimes(2); // one per page, second round all cached
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await resolveOrgMembers('key', ['human-1']);
    expect(notionGet).toHaveBeenCalledTimes(3);
  });

  it('does not cache transient read failures', async () => {
    vi.mocked(notionGet).mockRejectedValueOnce(new Error('boom'));
    expect(await resolveOrgMembers('key', ['human-1'])).toEqual([]);
    vi.mocked(notionGet).mockResolvedValueOnce(orgPage('human-1', humanProps()));
    const out = await resolveOrgMembers('key', ['human-1']);
    expect(out).toHaveLength(1);
  });

  it('dedupes dashed and dashless forms of the same id', async () => {
    vi.mocked(notionGet).mockResolvedValue(orgPage('aaaa-bbbb', humanProps()));
    const out = await resolveOrgMembers('key', ['aaaa-bbbb', 'aaaabbbb']);
    expect(out).toHaveLength(1);
    expect(notionGet).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the workspace has no Org DB', async () => {
    db.delete(notionDatabases).run();
    expect(await resolveOrgMembers('key', ['human-1'])).toEqual([]);
    expect(notionGet).not.toHaveBeenCalled();
  });
});

describe('listHumans', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('queries with the Type=Human filter, paginates, and attaches body excerpts', async () => {
    vi.mocked(notionQuery)
      .mockResolvedValueOnce({
        results: [orgPage('h-1', humanProps())],
        has_more: true, next_cursor: 'cur-2',
      })
      .mockResolvedValueOnce({
        results: [orgPage('h-2', humanProps({ 'Name': { type: 'title', title: rt('Léa') } }))],
        has_more: false, next_cursor: null,
      });
    vi.mocked(readPageMarkdown).mockResolvedValue('Knows every sponsor contract.');

    const humans = await listHumans('key');
    expect(humans.map(h => h.name)).toEqual(['Greg', 'Léa']);
    expect(humans[0]?.description).toBe('Knows every sponsor contract.');
    const [, , firstBody] = vi.mocked(notionQuery).mock.calls[0]!;
    expect(firstBody).toMatchObject({ filter: { property: 'Type', select: { equals: 'Human' } } });
    const [, , secondBody] = vi.mocked(notionQuery).mock.calls[1]!;
    expect(secondBody).toMatchObject({ start_cursor: 'cur-2' });
  });

  it('caches the list within the TTL and tolerates body-read failures', async () => {
    vi.mocked(notionQuery).mockResolvedValue({ results: [orgPage('h-1', humanProps())], has_more: false });
    vi.mocked(readPageMarkdown).mockRejectedValue(new Error('no body'));
    const first = await listHumans('key');
    expect(first[0]?.description).toBeUndefined();
    await listHumans('key');
    expect(notionQuery).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await listHumans('key');
    expect(notionQuery).toHaveBeenCalledTimes(2);
  });
});
