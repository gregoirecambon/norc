// Dual-sync: keep the on-disk chore.md files and rows in the Notion "Chores" DB in
// agreement. DISK stays the runtime source (load.ts is untouched); this is the
// mirror. Sync state lives in Notion (a per-row "Sync Hash" baseline) — no SQLite.
//
// Reconcile compares three things per chore: the disk content hash, the Notion body
// content hash, and the row's last-synced baseline. One side changed → propagate;
// both changed → CONFLICT (never clobber — flag it, keep last-known-good); equal →
// no-op (the steady state, and the loop guard together with the bot-author drop in
// processWebhookEvent). Imports never touch orchestrator.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionDatabases, notionIntegration } from '../db/schema.js';
import { notionGet, notionPost, notionPatch, notionDelete, notionQuery } from '../lib/notion-client.js';
import { toRichText, postComment, appendBlocks } from '../lib/notion-writeback.js';
import { getAnyTitle, getRichText, getSelect } from '../lib/notion-props.js';
import { emitLog } from '../lib/logger.js';
import { getNorcSettings } from '../lib/norc-settings.js';
import { loadChores, CHORES_DIR } from './load.js';
import { parseChore } from './parse.js';
import { serializeChore, choreContentHash } from './serialize.js';
import type { ChoreDoc } from './types.js';

function choresDb() {
  return db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'chores')).all()[0] ?? null;
}
function apiKey(): string | null {
  const i = db.select().from(notionIntegration).all()[0];
  return i && i.status === 'active' ? i.apiKey : null;
}

interface NotionChore {
  pageId: string;
  id: string;             // chore id (from parsed body, else title)
  doc: ChoreDoc | null;   // parsed body; null when the body code block is unparseable
  notionHash: string | null;
  baseline: string;       // the row's Sync Hash (last-synced)
}

/** Concatenate a code block's rich_text into its raw string. */
function codeBlockText(block: Record<string, unknown>): string {
  const code = block['code'] as Record<string, unknown> | undefined;
  const rt = (code?.['rich_text'] as Array<Record<string, unknown>> | undefined) ?? [];
  return rt.map(seg => {
    const t = seg['text'] as Record<string, unknown> | undefined;
    return typeof t?.['content'] === 'string' ? t['content'] : (typeof seg['plain_text'] === 'string' ? seg['plain_text'] as string : '');
  }).join('');
}

/** First fenced code block on a page → its text (the serialized chore spec). */
async function readBodyCode(key: string, pageId: string): Promise<string> {
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const res = await notionGet<Record<string, unknown>>(key, `/blocks/${pageId}/children${q}`);
    for (const b of (res['results'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (b['type'] === 'code') parts.push(codeBlockText(b));
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] as string : undefined;
  } while (cursor);
  return parts.join('\n').trim();
}

function specCodeBlock(doc: ChoreDoc): Record<string, unknown> {
  return { object: 'block', type: 'code', code: { language: 'markdown', rich_text: toRichText(serializeChore(doc)) } };
}

/** Delete every child block of a page (so the body can be rewritten). */
async function clearBody(key: string, pageId: string): Promise<void> {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const res = await notionGet<Record<string, unknown>>(key, `/blocks/${pageId}/children${q}`);
    for (const b of (res['results'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof b['id'] === 'string') ids.push(b['id']);
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] as string : undefined;
  } while (cursor);
  for (const id of ids) await notionDelete(key, `/blocks/${id}`);
}

function rowProps(doc: ChoreDoc, hash: string, state: 'synced' | 'conflict' | 'disk-only'): Record<string, unknown> {
  return {
    'Chore': { title: toRichText(doc.id) },
    'Description': { rich_text: toRichText(doc.description) },
    'Trigger': { select: { name: doc.trigger } },
    'Approval': { select: { name: doc.approval } },
    'Min Confidence': { number: doc.minConfidence },
    'Inputs': { rich_text: toRichText(doc.inputs.join(', ') || ' ') },
    'Sync State': { select: { name: state } },
    'Sync Hash': { rich_text: toRichText(hash) },
  };
}

/** Create or update a Notion row to match a disk chore, replacing its body spec. */
async function pushToNotion(key: string, dbId: string, doc: ChoreDoc, hash: string, existingPageId?: string): Promise<void> {
  if (existingPageId) {
    await notionPatch(key, `/pages/${existingPageId}`, { properties: rowProps(doc, hash, 'synced') });
    await clearBody(key, existingPageId);
    await appendBlocks(key, existingPageId, [specCodeBlock(doc)]);
  } else {
    const res = await notionPost<Record<string, unknown>>(key, '/pages', {
      parent: { database_id: dbId },
      properties: rowProps(doc, hash, 'synced'),
      children: [specCodeBlock(doc)],
    });
    void res;
  }
  emitLog(`chore sync: pushed "${doc.id}" → Notion`, 'NORC');
}

/** Write a chore back to disk (best-effort — the chores/ dir may be read-only in a
 * container without a mounted volume). Returns false on failure. */
function writeToDisk(doc: ChoreDoc): boolean {
  try {
    const dir = path.join(CHORES_DIR, doc.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'CHORE.md'), serializeChore(doc), 'utf8');
    emitLog(`chore sync: wrote "${doc.id}" → disk`, 'NORC');
    return true;
  } catch (err) {
    emitLog(`chore sync: could not write "${doc.id}" to disk (${err instanceof Error ? err.message : 'error'}) — Notion edit is not persisted; disk remains canonical`, 'NORC');
    return false;
  }
}

async function markRowState(key: string, pageId: string, state: 'synced' | 'conflict' | 'disk-only', hash?: string): Promise<void> {
  const props: Record<string, unknown> = { 'Sync State': { select: { name: state } } };
  if (hash !== undefined) props['Sync Hash'] = { rich_text: toRichText(hash) };
  await notionPatch(key, `/pages/${pageId}`, { properties: props });
}

/** Read every Chores row into a normalized shape. */
async function readNotionChores(key: string, dbId: string): Promise<Map<string, NotionChore>> {
  const out = new Map<string, NotionChore>();
  let cursor: string | undefined;
  do {
    const res = await notionQuery<Record<string, unknown>>(key, dbId, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const page of (res['results'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const pageId = typeof page['id'] === 'string' ? page['id'] : null;
      if (!pageId) continue;
      const props = page['properties'];
      const titleId = getAnyTitle(props).trim();
      const baseline = getRichText(props, 'Sync Hash').trim();
      let doc: ChoreDoc | null = null;
      try { const body = await readBodyCode(key, pageId); if (body) doc = parseChore(body); } catch { doc = null; }
      const id = doc?.id || titleId;
      if (!id) continue;
      out.set(id, { pageId, id, doc, notionHash: doc ? choreContentHash(doc) : null, baseline });
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] as string : undefined;
  } while (cursor);
  return out;
}

export type SyncAction = 'create' | 'pull' | 'push' | 'restore' | 'conflict' | 'noop';

/** PURE: decide what to do for one chore from the two sides' content hashes + the
 * row's last-synced baseline. Disk is canonical (wins first-sight + ties). Exported
 * for unit testing the decision matrix without the Notion plumbing. */
export function decideSync(
  disk: { hash: string } | null,
  notion: { hash: string | null; baseline: string } | null,
): SyncAction {
  if (disk && !notion) return 'create';                       // disk-only → create the row
  if (!disk && notion) return notion.hash ? 'pull' : 'noop';  // notion-only → write file back
  if (!disk || !notion) return 'noop';
  if (notion.hash === null) return 'restore';                 // unparseable Notion body → push disk over it
  if (disk.hash === notion.hash) return 'noop';               // agree (steady state / loop guard)
  if (!notion.baseline) return 'push';                        // no baseline to judge by → disk is canonical
  const diskChanged = disk.hash !== notion.baseline;
  const notionChanged = notion.hash !== notion.baseline;
  if (diskChanged && notionChanged) return 'conflict';        // both edited since last sync → never clobber
  if (notionChanged) return 'pull';
  return 'push';                                              // only disk changed → disk wins
}

/** Reconcile one chore id given its disk + Notion sides (executes decideSync). */
async function reconcileOne(
  key: string, dbId: string, id: string,
  disk: { doc: ChoreDoc; hash: string } | null,
  notion: NotionChore | null,
): Promise<void> {
  const action = decideSync(disk, notion ? { hash: notion.notionHash, baseline: notion.baseline } : null);
  switch (action) {
    case 'create':
      await pushToNotion(key, dbId, disk!.doc, disk!.hash);
      return;
    case 'pull': {
      const ok = writeToDisk(notion!.doc!);
      await markRowState(key, notion!.pageId, ok ? 'synced' : 'disk-only', ok ? (notion!.notionHash ?? undefined) : undefined);
      return;
    }
    case 'push':
    case 'restore':
      await pushToNotion(key, dbId, disk!.doc, disk!.hash, notion!.pageId);
      return;
    case 'conflict':
      await markRowState(key, notion!.pageId, 'conflict');
      await postComment(key, notion!.pageId,
        `⚠️ **NORC chore sync** — this chore was edited in BOTH Notion and the server file since the last sync, so I left both untouched. Make them match (edit one side), then sync again.`)
        .catch(() => undefined);
      emitLog(`chore sync: CONFLICT on "${id}" — both sides changed; left untouched`, 'NORC');
      return;
    case 'noop':
      // Keep the baseline current when both sides already agree but the row's hash drifted.
      if (disk && notion && notion.notionHash === disk.hash && notion.baseline !== disk.hash) {
        await markRowState(key, notion.pageId, 'synced', disk.hash);
      }
      return;
  }
}

/** Full reconcile of every chore (boot + periodic). Gated on choresNotionSync. */
export async function reconcile(): Promise<void> {
  if (!getNorcSettings()?.choresNotionSync) return;
  const dbRow = choresDb();
  const key = apiKey();
  if (!dbRow || !key) return;

  const disk = new Map<string, { doc: ChoreDoc; hash: string }>();
  for (const doc of loadChores()) disk.set(doc.id, { doc, hash: choreContentHash(doc) });
  const notion = await readNotionChores(key, dbRow.notionDatabaseId);

  for (const id of new Set([...disk.keys(), ...notion.keys()])) {
    try {
      await reconcileOne(key, dbRow.notionDatabaseId, id, disk.get(id) ?? null, notion.get(id) ?? null);
    } catch (err) {
      emitLog(`chore sync: error reconciling "${id}": ${err instanceof Error ? err.message : 'error'}`, 'NORC');
    }
  }
}

/** Per-chore sync state from the Notion rows (id → {state, url}); for the dashboard.
 * Best-effort: returns {} when the Chores DB isn't provisioned or Notion errors. */
export async function choreSyncStates(): Promise<Record<string, { state: string; url: string | null }>> {
  const out: Record<string, { state: string; url: string | null }> = {};
  const dbRow = choresDb();
  const key = apiKey();
  if (!dbRow || !key) return out;
  try {
    let cursor: string | undefined;
    do {
      const res = await notionQuery<Record<string, unknown>>(key, dbRow.notionDatabaseId, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const page of (res['results'] as Array<Record<string, unknown>> | undefined) ?? []) {
        const id = getAnyTitle(page['properties']).trim();
        if (!id) continue;
        out[id] = { state: getSelect(page['properties'], 'Sync State') ?? 'disk-only', url: typeof page['url'] === 'string' ? page['url'] : null };
      }
      cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] as string : undefined;
    } while (cursor);
  } catch { /* best-effort */ }
  return out;
}

/** The provisioned Chores DB (id + url) for the dashboard, or null. */
export function choresDbInfo(): { notionDatabaseId: string; url: string | null } | null {
  const row = choresDb();
  return row ? { notionDatabaseId: row.notionDatabaseId, url: row.url } : null;
}

/** Reconcile a single Notion row after a webhook edit (fast path). */
export async function reconcileFromNotion(pageId: string): Promise<void> {
  if (!getNorcSettings()?.choresNotionSync) return;
  const dbRow = choresDb();
  const key = apiKey();
  if (!dbRow || !key) return;

  const props = (await notionGet<Record<string, unknown>>(key, `/pages/${pageId}`))['properties'];
  const titleId = getAnyTitle(props).trim();
  const baseline = getRichText(props, 'Sync Hash').trim();
  let doc: ChoreDoc | null = null;
  try { const body = await readBodyCode(key, pageId); if (body) doc = parseChore(body); } catch { doc = null; }
  const id = doc?.id || titleId;
  if (!id) return;
  const notion: NotionChore = { pageId, id, doc, notionHash: doc ? choreContentHash(doc) : null, baseline };
  const diskDoc = loadChores().find(c => c.id === id);
  const disk = diskDoc ? { doc: diskDoc, hash: choreContentHash(diskDoc) } : null;
  await reconcileOne(key, dbRow.notionDatabaseId, id, disk, notion).catch(err =>
    emitLog(`chore sync: error reconciling row ${pageId}: ${err instanceof Error ? err.message : 'error'}`, 'NORC'));
}
