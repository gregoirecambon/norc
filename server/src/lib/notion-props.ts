// Pure readers for Notion page property values, keyed by the property name as it
// appears in the provisioned schemas (see notion-provision.ts). Each tolerates a
// missing/wrong-typed property and returns an empty value rather than throwing.

import { richTextToPlain } from './notion-anchor.js';

function prop(properties: unknown, name: string): Record<string, unknown> | null {
  if (!properties || typeof properties !== 'object') return null;
  const p = (properties as Record<string, unknown>)[name];
  return p && typeof p === 'object' ? p as Record<string, unknown> : null;
}

export function getTitle(properties: unknown, name: string): string {
  const p = prop(properties, name);
  return p?.['type'] === 'title' ? richTextToPlain(p['title']) : '';
}

/** The page's title, whatever the title property is called (free pages use
 * "title"; DB rows use the DB's title column). Returns '' if none. */
export function getAnyTitle(properties: unknown): string {
  if (!properties || typeof properties !== 'object') return '';
  for (const p of Object.values(properties as Record<string, unknown>)) {
    if (p && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'title') {
      return richTextToPlain((p as Record<string, unknown>)['title']);
    }
  }
  return '';
}

export function getRichText(properties: unknown, name: string): string {
  const p = prop(properties, name);
  return p?.['type'] === 'rich_text' ? richTextToPlain(p['rich_text']) : '';
}

export function getSelect(properties: unknown, name: string): string | null {
  const p = prop(properties, name);
  if (p?.['type'] !== 'select') return null;
  const sel = p['select'] as Record<string, unknown> | null;
  return typeof sel?.['name'] === 'string' ? sel['name'] : null;
}

export function getRelationIds(properties: unknown, name: string): string[] {
  const p = prop(properties, name);
  if (p?.['type'] !== 'relation' || !Array.isArray(p['relation'])) return [];
  return (p['relation'] as unknown[])
    .map(r => (r as Record<string, unknown> | null)?.['id'])
    .filter((id): id is string => typeof id === 'string');
}
