// Anchor resolution + comment-thread fetch.
//
// The "anchor" is the page a conversation lives on. We classify it by its parent
// database: a row in the Tasks DB is a task conversation, a row in the Projects
// DB a project conversation, anything else a free-page chat. Classification reads
// the locally-stored provisioned database ids (notionDatabases).

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionDatabases } from '../db/schema.js';
import { notionGet } from './notion-client.js';
import { extractMentionedPageIds, agentNamesByOrgPage, richTextToPlainNamed } from './notion-mentions.js';

export type AnchorKind = 'task' | 'project' | 'page';

export interface Anchor {
  kind: AnchorKind;
  pageId: string;
  page: Record<string, unknown>;
  parentDatabaseId: string | null;
}

export interface ThreadComment {
  id: string;
  discussionId: string | null;
  richText: unknown[];
  plainText: string;
  authorId: string | null;
  createdTime: string | null;
}

/** A sub-page or sub-database an agent can pull in full (id IS the page id). */
export interface ResourceRef {
  id: string;
  title: string;
  kind: 'page' | 'database';
}

/** dashless lowercase, so dashed/undashed Notion ids compare equal. */
export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function dbIdForKind(kind: 'tasks' | 'projects'): string | null {
  const row = db.select().from(notionDatabases).where(eq(notionDatabases.kind, kind)).all()[0];
  return row?.notionDatabaseId ?? null;
}

/** Fetch the page and classify it by parent.database_id. */
export async function resolveAnchor(apiKey: string, pageId: string): Promise<Anchor> {
  const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${pageId}`);
  const parent = page['parent'] as Record<string, unknown> | undefined;
  const parentDatabaseId = parent && typeof parent['database_id'] === 'string' ? parent['database_id'] : null;

  let kind: AnchorKind = 'page';
  if (parentDatabaseId) {
    const norm = normalizeId(parentDatabaseId);
    const tasksId = dbIdForKind('tasks');
    const projectsId = dbIdForKind('projects');
    if (tasksId && normalizeId(tasksId) === norm) kind = 'task';
    else if (projectsId && normalizeId(projectsId) === norm) kind = 'project';
  }

  return { kind, pageId, page, parentDatabaseId };
}

/** List the comment thread on a page (oldest→newest), following pagination. */
export async function listThreadComments(apiKey: string, pageId: string): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  const agentNames = agentNamesByOrgPage();
  let cursor: string | undefined;

  do {
    const qs = new URLSearchParams({ block_id: pageId, page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const res = await notionGet<Record<string, unknown>>(apiKey, `/comments?${qs.toString()}`);

    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const c of results) {
      const richText = Array.isArray(c['rich_text']) ? c['rich_text'] as unknown[] : [];
      const createdBy = c['created_by'] as Record<string, unknown> | undefined;
      out.push({
        id: String(c['id'] ?? ''),
        discussionId: typeof c['discussion_id'] === 'string' ? c['discussion_id'] : null,
        richText,
        plainText: richTextToPlainNamed(richText, agentNames),
        authorId: typeof createdBy?.['id'] === 'string' ? createdBy['id'] : null,
        createdTime: typeof c['created_time'] === 'string' ? c['created_time'] : null,
      });
    }

    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string'
      ? res['next_cursor']
      : undefined;
  } while (cursor);

  return out;
}

/** Scan a page's direct child blocks (1 level deep) for agent page mentions. */
export async function collectBlockMentionPageIds(apiKey: string, pageId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const res = await notionGet<Record<string, unknown>>(apiKey, `/blocks/${pageId}/children?${qs.toString()}`);

    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const block of results) {
      const type = block['type'];
      if (typeof type !== 'string') continue;
      // Each block type nests its content under a key named after the type,
      // e.g. paragraph.rich_text, heading_1.rich_text, to_do.rich_text.
      const body = block[type] as Record<string, unknown> | undefined;
      const rich = body?.['rich_text'];
      if (Array.isArray(rich)) ids.push(...extractMentionedPageIds(rich));
    }

    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string'
      ? res['next_cursor']
      : undefined;
  } while (cursor);

  return ids;
}

/** Read the plain text of a single block (the text a comment is anchored to). */
export async function readBlockText(apiKey: string, blockId: string): Promise<string> {
  try {
    const block = await notionGet<Record<string, unknown>>(apiKey, `/blocks/${blockId}`);
    return blockToText(block).trim();
  } catch {
    return '';
  }
}

/** Render one block to a markdown-ish line (text content only). */
function blockToText(block: Record<string, unknown>): string {
  const type = block['type'];
  if (typeof type !== 'string') return '';
  const body = block[type] as Record<string, unknown> | undefined;
  const text = richTextToPlain(body?.['rich_text']);
  switch (type) {
    case 'heading_1': return text ? `# ${text}` : '';
    case 'heading_2': return text ? `## ${text}` : '';
    case 'heading_3': return text ? `### ${text}` : '';
    case 'bulleted_list_item':
    case 'to_do': return text ? `- ${text}` : '';
    case 'numbered_list_item': return text ? `1. ${text}` : '';
    case 'toggle': return text ? `▸ ${text}` : '';
    case 'quote': return text ? `> ${text}` : '';
    case 'code': return text ? '```\n' + text + '\n```' : '';
    case 'child_page': {
      const t = body?.['title'];
      return typeof t === 'string' && t ? `- 📄 ${t}` : '';
    }
    case 'child_database': {
      const t = body?.['title'];
      return typeof t === 'string' && t ? `- 🗄 ${t}` : '';
    }
    default: return text;
  }
}

/**
 * Read a page's body as markdown-ish text, descending into nested children
 * (toggles, columns, bullet trees) to `maxDepth` — the fuller detail an agent
 * needs to actually understand a page, not just its top-level lines. Capped by
 * `maxChars` to keep prompts/replies bounded. Sub-pages/sub-databases are listed
 * by title but not recursed into (they're separate pages an agent can pull).
 */
export async function readPageMarkdown(apiKey: string, pageId: string, maxChars = 6000, maxDepth = 3): Promise<string> {
  const lines: string[] = [];
  const budget = { total: 0, hit: false };
  await walkBlockChildren(apiKey, pageId, 0, maxDepth, maxChars, lines, budget);
  return lines.join('\n');
}

async function walkBlockChildren(
  apiKey: string,
  blockId: string,
  depth: number,
  maxDepth: number,
  maxChars: number,
  lines: string[],
  budget: { total: number; hit: boolean },
): Promise<void> {
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const res = await notionGet<Record<string, unknown>>(apiKey, `/blocks/${blockId}/children?${qs.toString()}`);
    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const block of results) {
      const line = blockToText(block);
      if (line) {
        const indented = depth > 0 ? `${'  '.repeat(depth)}${line}` : line;
        lines.push(indented);
        budget.total += indented.length + 1;
        if (budget.total >= maxChars) { lines.push('…(truncated)'); budget.hit = true; return; }
      }
      // Descend into nested content, but never into separate sub-pages/databases.
      const type = block['type'];
      if (depth < maxDepth && block['has_children'] === true && type !== 'child_page' && type !== 'child_database') {
        const id = String(block['id'] ?? '');
        if (id) {
          await walkBlockChildren(apiKey, id, depth + 1, maxDepth, maxChars, lines, budget);
          if (budget.hit) return;
        }
      }
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] : undefined;
  } while (cursor);
}

/**
 * Scan a page's block subtree for child_page / child_database blocks — the
 * sub-pages and sub-databases an agent can pull in full. Descends layout blocks
 * (columns, toggles, synced blocks, lists) to `maxDepth` but never into the child
 * pages/databases themselves. Deduped by id, capped at `cap`, best-effort: a
 * partial/unreadable subtree yields what was found rather than throwing.
 */
export async function listChildResources(
  apiKey: string,
  pageId: string,
  maxDepth = 2,
  cap = 25,
): Promise<ResourceRef[]> {
  const out: ResourceRef[] = [];
  const seen = new Set<string>();
  await walkForResources(apiKey, pageId, 0, maxDepth, cap, out, seen);
  return out;
}

async function walkForResources(
  apiKey: string,
  blockId: string,
  depth: number,
  maxDepth: number,
  cap: number,
  out: ResourceRef[],
  seen: Set<string>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    let res: Record<string, unknown>;
    try {
      res = await notionGet<Record<string, unknown>>(apiKey, `/blocks/${blockId}/children?${qs.toString()}`);
    } catch {
      return; // unreadable subtree → keep what we already collected
    }
    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const block of results) {
      const type = block['type'];
      if (typeof type !== 'string') continue;
      if (type === 'child_page' || type === 'child_database') {
        const id = String(block['id'] ?? '');
        const key = normalizeId(id);
        if (id && !seen.has(key)) {
          seen.add(key);
          const body = block[type] as Record<string, unknown> | undefined;
          const title = typeof body?.['title'] === 'string' ? body['title'] as string : '';
          out.push({ id, title, kind: type === 'child_page' ? 'page' : 'database' });
          if (out.length >= cap) return;
        }
        continue; // never recurse into a child page/database
      }
      // Descend layout blocks (columns, toggles, synced blocks, lists, …).
      if (depth < maxDepth && block['has_children'] === true) {
        const id = String(block['id'] ?? '');
        if (id) {
          await walkForResources(apiKey, id, depth + 1, maxDepth, cap, out, seen);
          if (out.length >= cap) return;
        }
      }
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] : undefined;
  } while (cursor);
}

// Notion user display names, resolved on demand and cached for the process — so
// a comment thread reads as "Alice: …" instead of an opaque user id.
const userNameCache = new Map<string, string>();
export async function userDisplayName(apiKey: string, userId: string | null): Promise<string> {
  if (!userId) return '';
  const cached = userNameCache.get(userId);
  if (cached !== undefined) return cached;
  let name = '';
  try {
    const u = await notionGet<Record<string, unknown>>(apiKey, `/users/${userId}`);
    if (typeof u['name'] === 'string') name = u['name'];
  } catch { /* unknown user → empty */ }
  userNameCache.set(userId, name);
  return name;
}

/** Flatten a rich_text array to its plain text. */
export function richTextToPlain(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText
    .map(item => {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['plain_text'] === 'string') {
        return (item as Record<string, unknown>)['plain_text'] as string;
      }
      return '';
    })
    .join('');
}
