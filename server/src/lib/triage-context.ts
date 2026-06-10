// Evidence for the Triage Agent: each candidate's Notion Org DB profile (all
// non-empty properties + page body) and the anchor's task context (body, KPIs,
// linked project objective). Everything here is best-effort — a failed Notion
// read degrades to the SQLite-metadata-only candidate, never throws into triage.
// Profiles are TTL-cached (agent bios change rarely; triage fires in event
// bursts), so an edited Org DB page can be up to PROFILE_TTL_MS stale.

import { notionGet } from './notion-client.js';
import { readPageMarkdown, type Anchor } from './notion-anchor.js';
import { getTitle, getRichText, getSelect, getRelationIds, propertyPlainText } from './notion-props.js';
import type { TriageCandidate, TriageTaskContext } from './orchestrator-agent.js';

/** Char caps keep the triage prompt bounded (~15k chars at a 15-agent roster). */
const AGENT_BODY_MAX_CHARS = 700;
const PERSONA_FALLBACK_MAX_CHARS = 300;
const TASK_BODY_MAX_CHARS = 1800;
const PROJECT_OBJECTIVE_MAX_CHARS = 400;
/** Beyond this many candidates, the rest stay metadata-only (bounds Notion calls). */
const MAX_ENRICHED_CANDIDATES = 15;
const PROFILE_TTL_MS = 5 * 60_000;

export interface AgentProfile {
  specialty: string;
  capabilities: string;
  technology: string;
  description: string;
  /** Every other non-empty property, rendered to plain text. */
  properties: Array<{ name: string; value: string }>;
}

/** Properties that never go in the generic dump: Name is the roster-block header,
 * System Prompt is imperative persona text (used only as a description fallback),
 * and the explicitly-mapped fields get their own labeled lines. */
const EXCLUDED_PROPS = new Set(['Name', 'System Prompt', 'Specialty', 'Capabilities', 'Technology']);

/** Extract an agent's triage profile from its Org DB page properties + body.
 * Pure (exported for tests). */
export function parseAgentProfile(props: unknown, bodyMarkdown: string): AgentProfile {
  const specialty = getRichText(props, 'Specialty').trim();
  const capabilities = getRichText(props, 'Capabilities').trim();
  const technology = (getSelect(props, 'Technology') ?? getRichText(props, 'Technology')).trim();

  const properties: Array<{ name: string; value: string }> = [];
  if (props && typeof props === 'object') {
    for (const [name, p] of Object.entries(props as Record<string, unknown>)) {
      if (EXCLUDED_PROPS.has(name)) continue;
      const value = propertyPlainText(p).trim();
      if (value) properties.push({ name, value });
    }
  }

  let description = bodyMarkdown.trim().slice(0, AGENT_BODY_MAX_CHARS);
  if (!description) {
    const persona = getRichText(props, 'System Prompt').trim();
    if (persona) description = `(from persona) ${persona.slice(0, PERSONA_FALLBACK_MAX_CHARS)}`;
  }

  return { specialty, capabilities, technology, description, properties };
}

const profileCache = new Map<string, { at: number; profile: AgentProfile }>();

export function clearTriageContextCache(): void {
  profileCache.clear();
}

async function fetchAgentProfile(apiKey: string, orgDbPageId: string): Promise<AgentProfile> {
  const cached = profileCache.get(orgDbPageId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
  const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${orgDbPageId}`);
  // Depth 1: an agent bio page is flat prose; skipping nested blocks halves calls.
  const body = await readPageMarkdown(apiKey, orgDbPageId, AGENT_BODY_MAX_CHARS, 1).catch(() => '');
  const profile = parseAgentProfile(page['properties'], body);
  profileCache.set(orgDbPageId, { at: Date.now(), profile });
  return profile;
}

/**
 * Enrich roster candidates with their Org DB profiles. Human-curated Notion
 * values win over the (possibly stale or empty) SQLite registration metadata
 * already on the candidate; a failed fetch keeps the metadata-only candidate.
 */
export async function enrichCandidates(
  apiKey: string,
  candidates: Array<TriageCandidate & { orgDbPageId?: string | null }>,
): Promise<TriageCandidate[]> {
  const out: TriageCandidate[] = [];
  for (const [i, c] of candidates.entries()) {
    const { orgDbPageId, ...candidate } = c;
    if (!orgDbPageId || i >= MAX_ENRICHED_CANDIDATES) { out.push(candidate); continue; }
    try {
      const p = await fetchAgentProfile(apiKey, orgDbPageId);
      out.push({
        ...candidate,
        specialty: p.specialty || candidate.specialty,
        capabilities: p.capabilities || candidate.capabilities,
        technology: p.technology || candidate.technology,
        ...(p.description ? { description: p.description } : {}),
        ...(p.properties.length ? { properties: p.properties } : {}),
      });
    } catch {
      out.push(candidate);
    }
  }
  return out;
}

/**
 * The anchor-side evidence for triage: status/KPIs from the already-loaded page
 * properties, the page body, and the linked project's name + objective.
 */
export async function buildTaskContext(apiKey: string, anchor: Anchor): Promise<TriageTaskContext | undefined> {
  const props = (anchor.page as Record<string, unknown>)['properties'];
  const ctx: TriageTaskContext = {};

  if (anchor.kind === 'task') {
    const status = getSelect(props, 'Status');
    if (status) ctx.status = status;
    const kpis = getRichText(props, 'KPIs').trim();
    if (kpis) ctx.kpis = kpis;
    const projectPageId = getRelationIds(props, 'Project')[0];
    if (projectPageId) {
      try {
        const projectPage = await notionGet<Record<string, unknown>>(apiKey, `/pages/${projectPageId}`);
        const pp = projectPage['properties'];
        const name = getTitle(pp, 'Name').trim();
        if (name) ctx.projectName = name;
        const objective = getRichText(pp, 'Objective').trim();
        if (objective) ctx.projectObjective = objective.slice(0, PROJECT_OBJECTIVE_MAX_CHARS);
      } catch { /* project context is best-effort */ }
    }
  } else if (anchor.kind === 'project') {
    const objective = getRichText(props, 'Objective').trim();
    if (objective) ctx.projectObjective = objective.slice(0, PROJECT_OBJECTIVE_MAX_CHARS);
    const kpis = getRichText(props, 'KPIs').trim();
    if (kpis) ctx.kpis = kpis;
  }

  try {
    const body = (await readPageMarkdown(apiKey, anchor.pageId, TASK_BODY_MAX_CHARS)).trim();
    if (body) ctx.body = body;
  } catch { /* body is best-effort */ }

  return Object.keys(ctx).length ? ctx : undefined;
}
