import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test steers what GET /pages/:id returns per dep id.
const pages = new Map<string, Record<string, unknown> | Error>();
vi.mock('../lib/notion-client.js', () => ({
  notionGet: vi.fn(async (_key: string, path: string) => {
    const id = path.replace('/pages/', '');
    const v = pages.get(id);
    if (!v) throw new Error(`Could not find page with ID: ${id} (404)`);
    if (v instanceof Error) throw v;
    return v;
  }),
}));

import { unmetDependencies, detectDependencyCycle, getDependsOnIds } from '../lib/task-deps.js';

const taskPage = (status: string | null, deps: string[] = [], extra: Record<string, unknown> = {}) => ({
  properties: {
    'Name': { type: 'title', title: [{ plain_text: `task` }] },
    ...(status !== null ? { 'Status': { type: 'select', select: { name: status } } } : {}),
    'Depends On': { type: 'relation', relation: deps.map(id => ({ id })) },
  },
  ...extra,
});

const propsWithDeps = (deps: string[]) => taskPage('Backlog', deps).properties;

beforeEach(() => { pages.clear(); });

describe('unmetDependencies', () => {
  it('a Done dependency is met', async () => {
    pages.set('d1', taskPage('Done'));
    expect(await unmetDependencies('k', propsWithDeps(['d1']))).toEqual([]);
  });

  it('Backlog / In Progress / Failed dependencies are unmet (Failed holds for a human)', async () => {
    pages.set('d1', taskPage('Backlog'));
    pages.set('d2', taskPage('In Progress'));
    pages.set('d3', taskPage('Failed'));
    const unmet = await unmetDependencies('k', propsWithDeps(['d1', 'd2', 'd3']));
    expect(unmet.map(d => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(unmet[2]?.status).toBe('Failed');
  });

  it('an archived/trashed dependency is met (it can never become Done)', async () => {
    pages.set('d1', taskPage('Backlog', [], { archived: true }));
    pages.set('d2', taskPage('Backlog', [], { in_trash: true }));
    expect(await unmetDependencies('k', propsWithDeps(['d1', 'd2']))).toEqual([]);
  });

  it('a 404 (deleted/unshared) dependency is met', async () => {
    // not in `pages` → mock throws the 404-style error
    expect(await unmetDependencies('k', propsWithDeps(['gone']))).toEqual([]);
  });

  it('a transient API error holds (unmet) — never release on uncertainty', async () => {
    pages.set('d1', new Error('Notion GET /pages/d1 failed (500)'));
    const unmet = await unmetDependencies('k', propsWithDeps(['d1']));
    expect(unmet.map(d => d.id)).toEqual(['d1']);
  });

  it('no Depends On relation → nothing unmet', async () => {
    expect(await unmetDependencies('k', { 'Name': { title: [] } })).toEqual([]);
    expect(getDependsOnIds({})).toEqual([]);
  });
});

describe('detectDependencyCycle', () => {
  it('finds a direct A→B→A cycle', async () => {
    pages.set('B', taskPage('Backlog', ['A']));
    const props = taskPage('Backlog', ['B']).properties;
    expect(await detectDependencyCycle('k', 'A', props)).toBe(true);
  });

  it('finds a self-loop', async () => {
    const props = taskPage('Backlog', ['A']).properties;
    expect(await detectDependencyCycle('k', 'A', props)).toBe(true);
  });

  it('a clean chain is not a cycle', async () => {
    pages.set('B', taskPage('Backlog', ['C']));
    pages.set('C', taskPage('Done', []));
    const props = taskPage('Backlog', ['B']).properties;
    expect(await detectDependencyCycle('k', 'A', props)).toBe(false);
  });

  it('a diamond (shared dep, no cycle) is not a cycle', async () => {
    pages.set('B', taskPage('Backlog', ['D']));
    pages.set('C', taskPage('Backlog', ['D']));
    pages.set('D', taskPage('Backlog', []));
    const props = taskPage('Backlog', ['B', 'C']).properties;
    expect(await detectDependencyCycle('k', 'A', props)).toBe(false);
  });
});
