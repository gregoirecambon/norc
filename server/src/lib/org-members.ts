// Org DB member resolution — the counterpart to the sqlite `agents` table for
// everyone who ISN'T a registered agent: humans (Type = Human) and NORC itself
// (Type = Orchestrator). Mention/assignment ids that don't match an agent are
// resolved here against the Notion Org DB so the orchestrator can tell "this
// task went to a person" apart from "this relation points at a project".
//
// Everything is best-effort and TTL-cached like triage-context.ts: resolution
// failures degrade to "not a member" for this round (never cached), while
// confirmed non-Org pages are negative-cached so Project/Depends On relation
// ids don't cost a Notion call per webhook.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionDatabases } from '../db/schema.js';
import { notionGet, notionQuery } from './notion-client.js';
import { readPageMarkdown } from './notion-anchor.js';
import { getTitle, getAnyTitle, getSelect, getPeople, propertyPlainText } from './notion-props.js';

export type OrgMemberType = 'human' | 'ai_agent' | 'orchestrator' | 'unknown';

export interface OrgMember {
  /** Raw (dashed) Notion page id — usable directly in relation values and mentions. */
  pageId: string;
  name: string;
  type: OrgMemberType;
  /** Notion user ids from the Org DB "Owner" people property (for @-notifications). */
  ownerUserIds: string[];
  specialty: string;
  capabilities: string;
  status: string;
  /** Page body excerpt — populated by listHumans (triage evidence), not by resolveOrgMembers. */
  description?: string;
}

const MEMBER_TTL_MS = 5 * 60_000;
const HUMANS_TTL_MS = 5 * 60_000;
const MEMBER_BODY_MAX_CHARS = 400;

function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function orgDbId(): string | null {
  const row = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'org')).all()[0];
  return row?.notionDatabaseId ?? null;
}

function memberType(typeSelect: string | null): OrgMemberType {
  switch ((typeSelect ?? '').trim()) {
    case 'Human': return 'human';
    case 'AI Agent': return 'ai_agent';
    case 'Orchestrator': return 'orchestrator';
    default: return 'unknown';
  }
}

/** Build a member from an Org DB page's properties. Pure (exported for tests). */
export function parseOrgMember(pageId: string, props: unknown): OrgMember {
  const name = (getTitle(props, 'Name') || getAnyTitle(props)).trim();
  return {
    pageId,
    name,
    type: memberType(getSelect(props, 'Type')),
    ownerUserIds: getPeople(props, 'Owner'),
    specialty: props && typeof props === 'object'
      ? propertyPlainText((props as Record<string, unknown>)['Specialty']).trim() : '',
    capabilities: props && typeof props === 'object'
      ? propertyPlainText((props as Record<string, unknown>)['Capabilities']).trim() : '',
    status: getSelect(props, 'Status') ?? '',
  };
}

const NOT_A_MEMBER: Omit<OrgMember, 'pageId'> = {
  name: '', type: 'unknown', ownerUserIds: [], specialty: '', capabilities: '', status: '',
};

const memberCache = new Map<string, { at: number; member: OrgMember }>();
let humansCache: { at: number; humans: OrgMember[] } | null = null;

export function clearOrgMemberCache(): void {
  memberCache.clear();
  humansCache = null;
}

/**
 * Resolve candidate page ids (from mentions / Assigned To relations) to Org DB
 * members. Pages outside the Org DB come back as type 'unknown' internally and
 * are dropped from the result; only confirmed lookups are cached.
 */
export async function resolveOrgMembers(apiKey: string, pageIds: string[]): Promise<OrgMember[]> {
  const org = orgDbId();
  if (!org || pageIds.length === 0) return [];
  const orgNorm = normalizeId(org);

  const out: OrgMember[] = [];
  const seen = new Set<string>();
  for (const raw of pageIds) {
    const key = normalizeId(raw);
    if (seen.has(key)) continue;
    seen.add(key);

    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.at < MEMBER_TTL_MS) {
      if (cached.member.type !== 'unknown') out.push(cached.member);
      continue;
    }

    try {
      const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${raw}`);
      const parent = page['parent'] as Record<string, unknown> | undefined;
      const parentDb = typeof parent?.['database_id'] === 'string'
        ? normalizeId(parent['database_id'] as string) : null;
      const pageIdRaw = typeof page['id'] === 'string' ? page['id'] : raw;
      const member: OrgMember = parentDb === orgNorm
        ? parseOrgMember(pageIdRaw, page['properties'])
        : { pageId: pageIdRaw, ...NOT_A_MEMBER };
      memberCache.set(key, { at: Date.now(), member });
      if (member.type !== 'unknown') out.push(member);
    } catch {
      // Transient read failure: treat as not-a-member this round, don't cache.
    }
  }
  return out;
}

/** All Org DB pages with Type = Human, with a body excerpt for triage evidence. */
export async function listHumans(apiKey: string): Promise<OrgMember[]> {
  if (humansCache && Date.now() - humansCache.at < HUMANS_TTL_MS) return humansCache.humans;
  const org = orgDbId();
  if (!org) return [];

  const humans: OrgMember[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionQuery<Record<string, unknown>>(apiKey, org, {
      filter: { property: 'Type', select: { equals: 'Human' } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const results = Array.isArray(res['results']) ? res['results'] as Array<Record<string, unknown>> : [];
    for (const page of results) {
      const id = typeof page['id'] === 'string' ? page['id'] : null;
      if (!id) continue;
      const member = parseOrgMember(id, page['properties']);
      // Depth 1 like the agent profiles — a person's bio page is flat prose.
      const body = await readPageMarkdown(apiKey, id, MEMBER_BODY_MAX_CHARS, 1).catch(() => '');
      if (body.trim()) member.description = body.trim().slice(0, MEMBER_BODY_MAX_CHARS);
      humans.push(member);
      memberCache.set(normalizeId(id), { at: Date.now(), member });
    }
    cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string'
      ? res['next_cursor'] as string : undefined;
  } while (cursor);

  humansCache = { at: Date.now(), humans };
  return humans;
}
