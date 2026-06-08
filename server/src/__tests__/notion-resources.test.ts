// Resource discovery for dispatched agents: listChildResources walks a page's
// block subtree for sub-pages/databases (the addressable ids the prompt now
// surfaces), and collectProjectRelationRefs walks the project's linked docs.
// Network is mocked; the walking/dedupe/cap logic is real.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// blockId -> paginated children responses (one entry per page of results).
const childrenByBlock = new Map<string, Record<string, unknown>[]>();
// pageId -> page object (for collectProjectRelationRefs title reads).
const pagesById = new Map<string, Record<string, unknown>>();
// ids whose children fetch should throw (unreadable subtree).
const throwOnChildren = new Set<string>();

vi.mock('../lib/notion-client.js', () => ({
  NOTION_API: 'https://api.notion.com/v1',
  NOTION_VERSION: '2022-06-28',
  headers: () => ({}),
  notionGet: vi.fn(async (_key: string, path: string) => {
    const cm = /^\/blocks\/([^/]+)\/children/.exec(path);
    if (cm) {
      const id = cm[1]!;
      if (throwOnChildren.has(id)) throw new Error('forbidden');
      const cursor = /start_cursor=([^&]+)/.exec(path);
      const idx = cursor ? Number(cursor[1]!.replace('p', '')) : 0;
      const pages = childrenByBlock.get(id) ?? [{ results: [], has_more: false }];
      return pages[idx] ?? { results: [], has_more: false };
    }
    const pm = /^\/pages\/([^/?]+)/.exec(path);
    if (pm) return pagesById.get(pm[1]!) ?? { id: pm[1], properties: {} };
    return {};
  }),
  notionPost: vi.fn(async () => ({})),
  notionPatch: vi.fn(async () => ({})),
  notionQuery: vi.fn(async () => ({ results: [], has_more: false })),
}));

import { listChildResources } from '../lib/notion-anchor.js';
import { collectProjectRelationRefs } from '../lib/context-assembler.js';

const childPage = (id: string, title: string) =>
  ({ type: 'child_page', id, child_page: { title }, has_children: false });
const childDb = (id: string, title: string) =>
  ({ type: 'child_database', id, child_database: { title }, has_children: false });
const layout = (type: string, id: string, results: unknown[]) => {
  childrenByBlock.set(id, [{ results, has_more: false }]);
  return { type, id, [type]: {}, has_children: true };
};
const titlePage = (title: string) => ({ properties: { Name: { type: 'title', title: [{ plain_text: title }] } } });

beforeEach(() => {
  childrenByBlock.clear();
  pagesById.clear();
  throwOnChildren.clear();
});

describe('listChildResources', () => {
  it('lists flat child pages and databases with their ids', async () => {
    childrenByBlock.set('root', [{ results: [childPage('a', 'Spec'), childPage('b', 'Design'), childDb('c', 'Backlog')], has_more: false }]);
    const refs = await listChildResources('k', 'root');
    expect(refs).toEqual([
      { id: 'a', title: 'Spec', kind: 'page' },
      { id: 'b', title: 'Design', kind: 'page' },
      { id: 'c', title: 'Backlog', kind: 'database' },
    ]);
  });

  it('captures pages nested in layout blocks up to maxDepth, but not deeper', async () => {
    const tooDeep = layout('toggle', 'tg', [childPage('too-deep', 'Too Deep')]);
    const col = layout('column', 'col', [childPage('deep-ok', 'Deep OK'), tooDeep]);
    const cl = layout('column_list', 'cl', [col]);
    childrenByBlock.set('root', [{ results: [cl], has_more: false }]);
    const refs = await listChildResources('k', 'root'); // default maxDepth 2
    const ids = refs.map(r => r.id);
    expect(ids).toContain('deep-ok');
    expect(ids).not.toContain('too-deep');
  });

  it('follows pagination', async () => {
    childrenByBlock.set('root', [
      { results: [childPage('a', 'One')], has_more: true, next_cursor: 'p1' },
      { results: [childPage('b', 'Two')], has_more: false },
    ]);
    const refs = await listChildResources('k', 'root');
    expect(refs.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('dedupes a child surfaced twice (e.g. via a synced block)', async () => {
    const sync = layout('synced_block', 'sync-1', [childPage('dup', 'Shared')]);
    childrenByBlock.set('root', [{ results: [childPage('dup', 'Shared'), sync], has_more: false }]);
    const refs = await listChildResources('k', 'root');
    expect(refs.filter(r => r.id === 'dup')).toHaveLength(1);
  });

  it('caps the number of resources', async () => {
    const many = Array.from({ length: 30 }, (_, i) => childPage(`p${i}`, `T${i}`));
    childrenByBlock.set('root', [{ results: many, has_more: false }]);
    expect((await listChildResources('k', 'root', 2, 25))).toHaveLength(25);
  });

  it('keeps an untitled child (its id is the value) and never throws on an unreadable subtree', async () => {
    const box = layout('toggle', 'box', [childPage('u', '')]);
    childrenByBlock.set('root', [{ results: [box, childPage('x', 'Visible')], has_more: false }]);
    throwOnChildren.add('box'); // the nested subtree is unreadable
    const refs = await listChildResources('k', 'root');
    // 'box' subtree throws → skipped silently; the sibling is still returned.
    expect(refs.map(r => r.id)).toEqual(['x']);
  });

  it('keeps an untitled child page when readable', async () => {
    childrenByBlock.set('root', [{ results: [childPage('u', '')], has_more: false }]);
    expect(await listChildResources('k', 'root')).toEqual([{ id: 'u', title: '', kind: 'page' }]);
  });
});

describe('collectProjectRelationRefs', () => {
  it('returns linked docs (with relation name), skipping Company/Agents', async () => {
    pagesById.set('doc-1', titlePage('Spec'));
    pagesById.set('doc-2', titlePage('Design'));
    const projectProps = {
      Name: { type: 'title', title: [{ plain_text: 'Auth' }] },
      Docs: { type: 'relation', relation: [{ id: 'doc-1' }, { id: 'doc-2' }] },
      Company: { type: 'relation', relation: [{ id: 'co-1' }] },
      Agents: { type: 'relation', relation: [{ id: 'ag-1' }] },
    };
    const refs = await collectProjectRelationRefs('k', projectProps);
    expect(refs).toEqual([
      { id: 'doc-1', title: 'Spec', kind: 'page', relation: 'Docs' },
      { id: 'doc-2', title: 'Design', kind: 'page', relation: 'Docs' },
    ]);
  });

  it('returns [] for non-relation / empty props', async () => {
    expect(await collectProjectRelationRefs('k', null)).toEqual([]);
    expect(await collectProjectRelationRefs('k', { Name: { type: 'title', title: [] } })).toEqual([]);
  });
});
