// Agent @mention detection — the first, purely-algorithmic filter (no LLM).
//
// In Notion rich_text, an @mention of a page looks like:
//   { type: 'mention', mention: { type: 'page', page: { id: '<uuid>' } }, ... }
// Agents are pages in the Org DB, so they appear as `page` mentions. We collect
// those page ids and cross-reference them against the local `agents` table —
// agents.orgDbPageId IS our Org DB cache, so no Redis/API lookup is needed here.

import { db } from '../db/client.js';
import { agents } from '../db/schema.js';

export interface AgentRef {
  agentId: string;
  orgDbPageId: string;
  name: string;
  adapterType: string;
}

/** Notion returns dashed UUIDs; normalize to dashless lowercase for comparison. */
function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** Collect the page ids of every `page` mention in a rich_text array. */
export function extractMentionedPageIds(richText: unknown): string[] {
  if (!Array.isArray(richText)) return [];
  const ids: string[] = [];
  for (const item of richText) {
    if (!item || typeof item !== 'object') continue;
    const node = item as Record<string, unknown>;
    if (node['type'] !== 'mention') continue;
    const mention = node['mention'] as Record<string, unknown> | undefined;
    if (!mention || mention['type'] !== 'page') continue;
    const page = mention['page'] as Record<string, unknown> | undefined;
    const id = page?.['id'];
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/**
 * Collect target page ids from every relation-type property. This is how an
 * agent is "mentioned" via a property value — e.g. a Task's `Assigned To`
 * relation pointing at the agent's Org DB page. (matchAgents filters these down
 * to the ones that are actually agents, so non-agent relations like `Project`
 * are harmless.)
 */
export function extractRelationPageIds(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object') return [];
  const ids: string[] = [];
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const prop = value as Record<string, unknown>;
    if (prop['type'] === 'relation' && Array.isArray(prop['relation'])) {
      for (const rel of prop['relation'] as unknown[]) {
        const id = (rel as Record<string, unknown> | null)?.['id'];
        if (typeof id === 'string') ids.push(id);
      }
    }
  }
  return ids;
}

/** Collect page-mention ids embedded in title / rich_text property values. */
export function extractPropertyMentionPageIds(properties: unknown): string[] {
  if (!properties || typeof properties !== 'object') return [];
  const ids: string[] = [];
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const prop = value as Record<string, unknown>;
    if (prop['type'] === 'title' && Array.isArray(prop['title'])) {
      ids.push(...extractMentionedPageIds(prop['title']));
    } else if (prop['type'] === 'rich_text' && Array.isArray(prop['rich_text'])) {
      ids.push(...extractMentionedPageIds(prop['rich_text']));
    }
  }
  return ids;
}

/** Resolve mentioned page ids to registered agents via agents.orgDbPageId. */
export function matchAgents(mentionedPageIds: string[]): AgentRef[] {
  if (mentionedPageIds.length === 0) return [];
  const wanted = new Set(mentionedPageIds.map(normalizeId));

  const matched: AgentRef[] = [];
  const seen = new Set<string>();
  for (const row of db.select().from(agents).all()) {
    if (!row.orgDbPageId) continue;
    if (!wanted.has(normalizeId(row.orgDbPageId))) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    matched.push({
      agentId: row.id,
      orgDbPageId: row.orgDbPageId,
      name: row.name,
      adapterType: row.adapterType,
    });
  }
  return matched;
}
