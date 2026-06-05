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
import { extractMentionedPageIds } from './notion-mentions.js';

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

/** dashless lowercase, so dashed/undashed Notion ids compare equal. */
function normalizeId(id: string): string {
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
        plainText: richTextToPlain(richText),
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
    case 'quote': return text ? `> ${text}` : '';
    case 'code': return text ? '```\n' + text + '\n```' : '';
    default: return text;
  }
}

/**
 * Read a page's body as markdown-ish text (direct children, 1 level deep) — the
 * fuller detail an agent can request when it needs more than the snippet/link.
 * Capped to keep replies bounded.
 */
export async function readPageMarkdown(apiKey: string, pageId: string, maxChars = 6000): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let total = 0;

  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const res = await notionGet<Record<string, unknown>>(apiKey, `/blocks/${pageId}/children?${qs.toString()}`);
    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const block of results) {
      const line = blockToText(block);
      if (!line) continue;
      lines.push(line);
      total += line.length + 1;
      if (total >= maxChars) { lines.push('…(truncated)'); return lines.join('\n'); }
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] : undefined;
  } while (cursor);

  return lines.join('\n');
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
