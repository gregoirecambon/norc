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

/** A number property's value, or null. */
export function getNumber(properties: unknown, name: string): number | null {
  const p = prop(properties, name);
  return typeof p?.['number'] === 'number' ? (p['number'] as number) : null;
}

/** A date property's start as an ISO string, or null. */
export function getDate(properties: unknown, name: string): string | null {
  const p = prop(properties, name);
  if (p?.['type'] !== 'date') return null;
  const d = p['date'] as Record<string, unknown> | null;
  return typeof d?.['start'] === 'string' ? d['start'] : null;
}

/** User ids from a people property (e.g. the Org DB "Owner"), or []. */
export function getPeople(properties: unknown, name: string): string[] {
  const p = prop(properties, name);
  if (p?.['type'] !== 'people' || !Array.isArray(p['people'])) return [];
  return (p['people'] as unknown[])
    .map(u => (u as Record<string, unknown> | null)?.['id'])
    .filter((id): id is string => typeof id === 'string');
}

/** Render any simple property value to plain text — '' when empty or of a type
 * we don't flatten (relation/people/rollup/formula/files). Used to dump a page's
 * non-empty properties generically (e.g. the Org DB agent profile for triage). */
export function propertyPlainText(p: unknown): string {
  if (!p || typeof p !== 'object') return '';
  const r = p as Record<string, unknown>;
  switch (r['type']) {
    case 'title': return richTextToPlain(r['title']);
    case 'rich_text': return richTextToPlain(r['rich_text']);
    case 'select': {
      const sel = r['select'] as Record<string, unknown> | null;
      return typeof sel?.['name'] === 'string' ? sel['name'] : '';
    }
    case 'status': {
      const st = r['status'] as Record<string, unknown> | null;
      return typeof st?.['name'] === 'string' ? st['name'] : '';
    }
    case 'multi_select': {
      if (!Array.isArray(r['multi_select'])) return '';
      return (r['multi_select'] as unknown[])
        .map(o => (o as Record<string, unknown> | null)?.['name'])
        .filter((n): n is string => typeof n === 'string')
        .join(', ');
    }
    case 'number': return typeof r['number'] === 'number' ? String(r['number']) : '';
    case 'checkbox': return typeof r['checkbox'] === 'boolean' ? (r['checkbox'] ? 'yes' : 'no') : '';
    case 'url': return typeof r['url'] === 'string' ? r['url'] : '';
    case 'email': return typeof r['email'] === 'string' ? r['email'] : '';
    case 'phone_number': return typeof r['phone_number'] === 'string' ? r['phone_number'] : '';
    case 'date': {
      const d = r['date'] as Record<string, unknown> | null;
      return typeof d?.['start'] === 'string' ? d['start'] : '';
    }
    default: return '';
  }
}

export function getRelationIds(properties: unknown, name: string): string[] {
  const p = prop(properties, name);
  if (p?.['type'] !== 'relation' || !Array.isArray(p['relation'])) return [];
  return (p['relation'] as unknown[])
    .map(r => (r as Record<string, unknown> | null)?.['id'])
    .filter((id): id is string => typeof id === 'string');
}
