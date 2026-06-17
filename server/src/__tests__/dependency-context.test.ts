import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive GET /pages/:id and GET /blocks/:id/children per id. readPageMarkdown and
// listPageMedia (inside notion-anchor) also flow through this mocked notionGet.
const pages = new Map<string, Record<string, unknown>>();
const children = new Map<string, Record<string, unknown>[]>();
vi.mock('../lib/notion-client.js', () => ({
  notionGet: vi.fn(async (_key: string, path: string) => {
    const page = path.match(/^\/pages\/([^/?]+)$/);
    if (page) {
      const v = pages.get(page[1]!);
      if (!v) throw new Error(`Could not find page ${page[1]} (404)`);
      return v;
    }
    const child = path.match(/^\/blocks\/([^/?]+)\/children/);
    if (child) return { results: children.get(child[1]!) ?? [], has_more: false };
    throw new Error(`unexpected path ${path}`);
  }),
}));

import { resolveDependencyContext } from '../lib/task-deps.js';
import { mediaBlockInfo } from '../lib/notion-anchor.js';
import { dependencySection } from '../lib/context-assembler.js';

const para = (text: string) => ({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] }, has_children: false });
const image = (url: string, caption?: string) => ({
  type: 'image',
  image: { type: 'file', file: { url }, caption: caption ? [{ plain_text: caption }] : [] },
  has_children: false,
});
const fileBlk = (url: string, name: string) => ({
  type: 'file',
  file: { type: 'file', file: { url }, name, caption: [] },
  has_children: false,
});

const depPage = (opts: { title?: string; status?: string; agentOutput?: string }) => ({
  properties: {
    'Name': { type: 'title', title: [{ plain_text: opts.title ?? 'Dep' }] },
    'Status': { type: 'select', select: { name: opts.status ?? 'Done' } },
    'Agent Output': { type: 'rich_text', rich_text: opts.agentOutput ? [{ plain_text: opts.agentOutput }] : [] },
    'Depends On': { type: 'relation', relation: [] },
  },
});

const dependentProps = (deps: string[]) => ({
  'Depends On': { type: 'relation', relation: deps.map(id => ({ id })) },
});

beforeEach(() => { pages.clear(); children.clear(); });

describe('resolveDependencyContext', () => {
  it('hands off a text-only predecessor: summary + body, no artifacts', async () => {
    pages.set('d1', depPage({ title: 'Research', status: 'Done', agentOutput: 'Found 3 sources' }));
    children.set('d1', [para('Key finding: the market is growing.'), para('See details below.')]);
    const [dep] = await resolveDependencyContext('k', dependentProps(['d1']));
    expect(dep!.name).toBe('Research');
    expect(dep!.status).toBe('Done');
    expect(dep!.summary).toBe('Found 3 sources');
    expect(dep!.body).toContain('Key finding');
    expect(dep!.artifacts).toEqual([]);
  });

  it('surfaces a single image predecessor: URL inline in body AND in artifacts', async () => {
    pages.set('d1', depPage({ title: 'Photo', status: 'Done' }));
    children.set('d1', [para('Here is the shot:'), image('https://notion.s3/hero.png', 'Hero on white')]);
    const [dep] = await resolveDependencyContext('k', dependentProps(['d1']));
    expect(dep!.body).toContain('https://notion.s3/hero.png');
    expect(dep!.artifacts).toHaveLength(1);
    expect(dep!.artifacts[0]).toMatchObject({ kind: 'image', url: 'https://notion.s3/hero.png', caption: 'Hero on white' });
  });

  it('surfaces a mix of multiple images and text, in document order', async () => {
    pages.set('d1', depPage({ status: 'Done' }));
    children.set('d1', [
      para('Intro'),
      image('https://n/a.png', 'A'),
      para('Middle'),
      image('https://n/b.png', 'B'),
      fileBlk('https://n/data.csv', 'data.csv'),
    ]);
    const [dep] = await resolveDependencyContext('k', dependentProps(['d1']));
    expect(dep!.body.indexOf('Intro')).toBeLessThan(dep!.body.indexOf('a.png'));
    expect(dep!.body.indexOf('a.png')).toBeLessThan(dep!.body.indexOf('Middle'));
    expect(dep!.body.indexOf('Middle')).toBeLessThan(dep!.body.indexOf('b.png'));
    expect(dep!.artifacts.map(a => a.url)).toEqual(['https://n/a.png', 'https://n/b.png', 'https://n/data.csv']);
    expect(dep!.artifacts.map(a => a.kind)).toEqual(['image', 'image', 'file']);
  });

  it('skips an unreadable predecessor (404) without throwing', async () => {
    const res = await resolveDependencyContext('k', dependentProps(['gone']));
    expect(res).toEqual([]);
  });

  it('hands off multiple predecessors in order', async () => {
    pages.set('d1', depPage({ title: 'One', status: 'Done', agentOutput: 'o1' }));
    pages.set('d2', depPage({ title: 'Two', status: 'Done', agentOutput: 'o2' }));
    children.set('d1', [para('body1')]);
    children.set('d2', [para('body2')]);
    const res = await resolveDependencyContext('k', dependentProps(['d1', 'd2']));
    expect(res.map(d => d.name)).toEqual(['One', 'Two']);
    expect(res.map(d => d.summary)).toEqual(['o1', 'o2']);
  });
});

describe('mediaBlockInfo', () => {
  it('reads a Notion-hosted image (file.url)', () => {
    expect(mediaBlockInfo(image('https://n/x.png', 'cap'))).toMatchObject({ kind: 'image', url: 'https://n/x.png', caption: 'cap' });
  });
  it('reads an external image (external.url)', () => {
    const ext = { type: 'image', image: { type: 'external', external: { url: 'https://ext/y.png' }, caption: [] } };
    expect(mediaBlockInfo(ext)).toMatchObject({ kind: 'image', url: 'https://ext/y.png' });
  });
  it('reads a file block, keeping its name', () => {
    expect(mediaBlockInfo(fileBlk('https://n/d.pdf', 'd.pdf'))).toMatchObject({ kind: 'file', url: 'https://n/d.pdf', name: 'd.pdf' });
  });
  it('returns null for a non-media block', () => {
    expect(mediaBlockInfo(para('hello'))).toBeNull();
  });
  it('returns null when no url is present', () => {
    expect(mediaBlockInfo({ type: 'image', image: { type: 'file', file: {}, caption: [] } })).toBeNull();
  });
});

describe('dependencySection (prompt rendering)', () => {
  it('renders summary, body, and a files list per dependency', () => {
    const text = dependencySection([{
      id: 'd1', name: 'Take photo', status: 'Done',
      summary: 'shot it', body: 'Here is the result\n![Hero](https://n/hero.png)',
      artifacts: [{ kind: 'image', name: 'image', url: 'https://n/hero.png', caption: 'Hero' }],
    }]);
    expect(text).toContain('Take photo (Done) — pageId: d1');
    expect(text).toContain('summary: shot it');
    expect(text).toContain('output:');
    expect(text).toContain('https://n/hero.png');
    expect(text).toContain('files:');
  });

  it('omits empty fields gracefully (text-only, no artifacts)', () => {
    const text = dependencySection([{
      id: 'd2', name: 'Notes', status: 'Done', summary: '', body: 'just some text', artifacts: [],
    }]);
    expect(text).toContain('Notes (Done) — pageId: d2');
    expect(text).toContain('output:');
    expect(text).not.toContain('summary:');
    expect(text).not.toContain('files:');
  });
});
