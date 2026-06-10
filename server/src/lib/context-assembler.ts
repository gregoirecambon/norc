// Context assembly — the ladder that decides how much an agent sees, gated by
// the agent's Org DB "Context Level":
//   task       → the task only
//   project    → + the linked Project's Objective / KPIs / Docs   (default)
//   strategic  → + company context  (Phase 4; treated as project for now)
//
// assembleContext() reads the agent's persona + level and walks Notion relations
// to that depth. buildPrompt() turns the structured context (plus the
// conversation thread and the triggering request) into the message sent to the
// agent. Property names match the provisioned schemas (notion-provision.ts).

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionDatabases } from '../db/schema.js';
import { notionGet, notionQuery } from './notion-client.js';
import { getTitle, getRichText, getSelect, getRelationIds, getAnyTitle } from './notion-props.js';
import { readPageMarkdown, listChildResources, normalizeId, type Anchor, type ResourceRef } from './notion-anchor.js';
import { tokenize, titleSimilarity } from './task-similarity.js';
import type { AgentRef } from './notion-mentions.js';

// How much written content to inject. The anchor page's own body is the richest
// signal; related rows are summaries. A final budget pass (assembleWithBudget)
// guarantees the whole prompt stays bounded regardless of how deep these go.
const PAGE_BODY_MAX_CHARS = 4000;
const RELATED_SUMMARY_MAX_CHARS = 600;
const MAX_RELATED_ROWS = 8;
const MAX_PROJECT_RESOURCES = 25;
// A resource the request explicitly names is pre-fetched and inlined — bounded so
// a few named docs can't blow the budget on their own.
const INLINE_RESOURCE_MAX_CHARS = 2500;
const MAX_INLINED_RESOURCES = 3;
const MAX_CONTEXT_CHARS = Number(process.env['NORC_MAX_CONTEXT_CHARS']) || 24000;

export type ContextLevel = 'task' | 'project' | 'strategic';

export interface TaskBlock {
  name: string;
  status: string;
  kpis: string;
  priorOutput: string;
  lastCheckpoint: string;
}

export interface ProjectBlock {
  name: string;
  objective: string;
  kpis: string;
  docs: string;
}

export interface CompanyBlock {
  name: string;
  type: string;
  content: string;
}

export interface RelatedBlock {
  relation: string;
  name: string;
  summary: string;
  /** The linked page's id, so the agent can fetch it in full via /page. */
  id: string;
}

/** A resource named in the request, pre-fetched so the agent needs no round-trip. */
export interface InlinedResource {
  title: string;
  pageId: string;
  markdown: string;
}

export interface AssembledContext {
  contextLevel: ContextLevel;
  systemPrompt: string;
  taskBlock: TaskBlock | null;
  projectBlock: ProjectBlock | null;
  companyBlocks: CompanyBlock[];
  relatedBlocks: RelatedBlock[];
  /** Sub-pages/databases under the anchor + project page, each with its id, so the
   * agent can pull any of them in full via /page?pageId=<id>. */
  projectResources: ResourceRef[];
  /** Sub-pages the request explicitly named, pre-fetched and inlined. */
  inlinedResources: InlinedResource[];
  /** The anchor page's actual written body (markdown-ish), not just properties. */
  bodyMarkdown: string;
  /** The linked Project page's written body — only when the anchor is a task
   * (when the anchor IS the project, its body is already in bodyMarkdown). */
  projectBody: string;
  /** Broad fingerprint — hashes the FULL assembled context (incl. page body and
   * inlined resources). Currently informational; kept for compatibility. */
  fingerprint: string;
  /** Narrow fingerprint governing session reuse: only the durable framing
   * (system prompt + resolved project/strategic/related context + context level).
   * Editing the task body does NOT change it — so an agent's session is reused
   * across normal back-and-forth and rebuilt only when its framing changes. */
  sessionFingerprint: string;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are an AI agent participating in NORC orchestration through a Notion workspace. ' +
  'Use the provided context to complete the request. Reply with a single, complete, concise message.';

function fingerprintOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Build the structured context for one agent on one anchor. */
export async function assembleContext(args: {
  apiKey: string;
  anchor: Anchor;
  agentRef: AgentRef;
  /** The triggering request/ask, used to eagerly inline any resource it names.
   * Omitted on request-agnostic callers (e.g. the /context endpoint). */
  request?: string;
}): Promise<AssembledContext> {
  const { apiKey, anchor, agentRef, request } = args;

  // Agent persona + clearance from its Org DB page.
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  let contextLevel: ContextLevel = 'project';
  try {
    const agentPage = await notionGet<Record<string, unknown>>(apiKey, `/pages/${agentRef.orgDbPageId}`);
    const props = agentPage['properties'];
    const sp = getRichText(props, 'System Prompt').trim();
    if (sp) systemPrompt = sp;
    const lvl = getSelect(props, 'Context Level');
    if (lvl === 'task' || lvl === 'project' || lvl === 'strategic') contextLevel = lvl;
  } catch {
    // fall back to defaults if the agent page can't be read
  }

  let taskBlock: TaskBlock | null = null;
  let projectBlock: ProjectBlock | null = null;
  let projectProps: unknown = null;
  let projectPageId: string | null = null;

  if (anchor.kind === 'task') {
    const props = (anchor.page as Record<string, unknown>)['properties'];
    taskBlock = {
      name: getTitle(props, 'Name'),
      status: getSelect(props, 'Status') ?? '',
      kpis: getRichText(props, 'KPIs'),
      priorOutput: getRichText(props, 'Agent Output'),
      lastCheckpoint: getRichText(props, 'Last Checkpoint'),
    };
    projectPageId = getRelationIds(props, 'Project')[0] ?? null;
  } else if (anchor.kind === 'project') {
    projectPageId = anchor.pageId;
  }

  // Project layer only for project/strategic clearance (and when one is linked).
  if (contextLevel !== 'task' && projectPageId) {
    try {
      const projectPage = anchor.kind === 'project'
        ? (anchor.page as Record<string, unknown>)
        : await notionGet<Record<string, unknown>>(apiKey, `/pages/${projectPageId}`);
      const pp = projectPage['properties'];
      projectProps = pp;
      projectBlock = {
        name: getTitle(pp, 'Name'),
        objective: getRichText(pp, 'Objective'),
        kpis: getRichText(pp, 'KPIs'),
        docs: getRichText(pp, 'Docs'),
      };
    } catch {
      // no project context if it can't be read
    }
  }

  // Strategic (company) layer — only for `strategic` clearance.
  const companyBlocks = contextLevel === 'strategic'
    ? await resolveCompanyBlocks(apiKey, projectProps)
    : [];

  // Deeper relations — follow the project's other relations (Docs, Knowledge,
  // Meetings, …) so the agent sees the linked material, not just the project's
  // properties. Available from `project` clearance up: a project-level agent on a
  // task needs the linked docs (e.g. an onboarding write-up) to do the work.
  const relatedBlocks = contextLevel !== 'task'
    ? await resolveRelatedBlocks(apiKey, projectProps)
    : [];

  // The anchor page's actual written content — the single biggest context gain.
  // Best-effort: an unreadable body just yields properties-only context.
  let bodyMarkdown = '';
  try {
    bodyMarkdown = (await readPageMarkdown(apiKey, anchor.pageId, PAGE_BODY_MAX_CHARS)).trim();
  } catch { /* body is best-effort */ }

  // The linked Project page's own body (task anchors). On a project anchor the
  // body above already IS the project body, so only fetch when anchored on a task.
  let projectBody = '';
  if (contextLevel !== 'task' && projectPageId && anchor.kind === 'task') {
    try {
      projectBody = (await readPageMarkdown(apiKey, projectPageId, PAGE_BODY_MAX_CHARS)).trim();
    } catch { /* project body is best-effort */ }
  }

  // Sub-pages / sub-databases the agent can pull in full — the anchor's own
  // children always, the project's children when clearance reaches the project
  // layer. Surfacing their ids is what lets an agent fetch a named doc (the
  // prompt previously listed sub-page TITLES with no addressable id).
  let projectResources: ResourceRef[] = [];
  try {
    const anchorNorm = normalizeId(anchor.pageId);
    const projectNorm = projectPageId ? normalizeId(projectPageId) : '';
    const seen = new Set<string>();
    const collected: ResourceRef[] = [];
    const pushAll = (refs: ResourceRef[]) => {
      for (const r of refs) {
        const key = normalizeId(r.id);
        if (key === anchorNorm || key === projectNorm || seen.has(key)) continue;
        seen.add(key);
        collected.push(r);
      }
    };
    pushAll(await listChildResources(apiKey, anchor.pageId));
    if (contextLevel !== 'task' && projectPageId && anchor.kind === 'task') {
      pushAll(await listChildResources(apiKey, projectPageId));
    }
    projectResources = collected.slice(0, MAX_PROJECT_RESOURCES);
  } catch { /* resources are best-effort */ }

  // Eagerly inline any resource the request explicitly names — so a "describe the
  // ONBOARDING doc" task arrives with that doc's body already in the prompt.
  const inlinedResources: InlinedResource[] = [];
  if (request && projectResources.length > 0) {
    const matches = matchResourcesByName(`${taskBlock?.name ?? ''} ${request}`, projectResources, MAX_INLINED_RESOURCES);
    const fetched = new Set<string>([normalizeId(anchor.pageId)]);
    if (projectPageId) fetched.add(normalizeId(projectPageId));
    for (const ref of matches) {
      const key = normalizeId(ref.id);
      if (fetched.has(key)) continue; // already inlined as a body above
      fetched.add(key);
      try {
        const md = (await readPageMarkdown(apiKey, ref.id, INLINE_RESOURCE_MAX_CHARS, 2)).trim();
        if (md) inlinedResources.push({ title: ref.title || '(untitled)', pageId: ref.id, markdown: md });
      } catch { /* best-effort */ }
    }
  }

  const fingerprint = fingerprintOf({ systemPrompt, contextLevel, projectBlock, companyBlocks, relatedBlocks, projectResources, inlinedResources, bodyMarkdown, projectBody });
  // Narrow fingerprint: durable framing only (no body/resources), so session reuse
  // survives task-body edits and rebuilds only when the agent's framing changes.
  const sessionFingerprint = fingerprintOf({ systemPrompt, contextLevel, projectBlock, companyBlocks, relatedBlocks });
  return { contextLevel, systemPrompt, taskBlock, projectBlock, companyBlocks, relatedBlocks, projectResources, inlinedResources, bodyMarkdown, projectBody, fingerprint, sessionFingerprint };
}

/**
 * Resources whose title the request/task explicitly names (case- and
 * punctuation-insensitive), best first, capped. Databases are excluded — there's
 * no readable body to inline. PURE.
 */
export function matchResourcesByName(haystack: string, refs: ResourceRef[], max = MAX_INLINED_RESOURCES): ResourceRef[] {
  const hayTokens = tokenize(haystack);
  if (hayTokens.length === 0) return [];
  const haySet = new Set(hayTokens);
  // A title token "hits" the request if it appears verbatim, or shares a 4+ char
  // prefix with a request token — so "onboard" in the ask matches an "Onboarding"
  // sub-page (token-exact matching would miss the morphological variant).
  const tokenHit = (t: string) =>
    haySet.has(t) || (t.length >= 4 && hayTokens.some(h => h.length >= 4 && (h.startsWith(t) || t.startsWith(h))));
  const scored: { ref: ResourceRef; score: number }[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'page') continue;
    const titleTokens = tokenize(ref.title);
    if (titleTokens.length === 0) continue;
    const hits = titleTokens.filter(tokenHit).length;
    if (hits === 0) continue;
    const allPresent = hits === titleTokens.length;
    const sim = titleSimilarity(ref.title, haystack);
    if (allPresent || sim >= 0.6) scored.push({ ref, score: allPresent ? 1 : Math.max(sim, hits / titleTokens.length) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(s => s.ref);
}

// Project relations handled elsewhere (Company → strategic layer) or irrelevant
// as context (Agents → the roster, not material).
const SKIP_RELATIONS = new Set(['Company', 'Agents']);

/** A linked doc reached through a project relation (carries the relation name). */
export interface RelationRef extends ResourceRef {
  relation: string;
}

/**
 * Walk the project's relation properties (other than Company/Agents) and return
 * the linked rows as refs (id + title + relation name), capped per relation and
 * overall. Best-effort. Shared by related-block assembly and the /resource
 * resolver so SKIP_RELATIONS stays a single source of truth.
 */
export async function collectProjectRelationRefs(apiKey: string, projectProps: unknown, cap = MAX_RELATED_ROWS): Promise<RelationRef[]> {
  if (!projectProps || typeof projectProps !== 'object') return [];
  const props = projectProps as Record<string, unknown>;
  const out: RelationRef[] = [];

  for (const [propName, val] of Object.entries(props)) {
    if (SKIP_RELATIONS.has(propName)) continue;
    if (!val || typeof val !== 'object' || (val as Record<string, unknown>)['type'] !== 'relation') continue;
    const ids = getRelationIds(props, propName);
    for (const id of ids.slice(0, 3)) {
      try {
        const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
        out.push({ id, title: getAnyTitle(page['properties']), kind: 'page', relation: propName });
        if (out.length >= cap) return out;
      } catch { /* skip unreadable row */ }
    }
  }
  return out;
}

/**
 * The project's linked docs/knowledge/meetings as related blocks — each with a
 * short body snippet. Best-effort and capped so deep graphs stay bounded.
 */
async function resolveRelatedBlocks(apiKey: string, projectProps: unknown): Promise<RelatedBlock[]> {
  const refs = await collectProjectRelationRefs(apiKey, projectProps, MAX_RELATED_ROWS);
  const out: RelatedBlock[] = [];
  for (const ref of refs) {
    let summary = '';
    try {
      summary = (await readPageMarkdown(apiKey, ref.id, RELATED_SUMMARY_MAX_CHARS, 1)).trim();
    } catch { /* summary is best-effort; still surface the ref so it's fetchable */ }
    out.push({ relation: ref.relation, name: ref.title, summary, id: ref.id });
  }
  return out;
}

/**
 * Resolve company context, two-layer gated:
 *   (a) prefer Active Company rows linked to the current Project (Projects→Company);
 *   (b) fall back to Active `Type=Vision` rows from the Company DB.
 * Best-effort: any read failure yields fewer rows, never throws.
 */
async function resolveCompanyBlocks(apiKey: string, projectProps: unknown): Promise<CompanyBlock[]> {
  const out: CompanyBlock[] = [];

  // (a) Company rows explicitly linked to this project.
  const linkedIds = projectProps ? getRelationIds(projectProps, 'Company') : [];
  for (const id of linkedIds.slice(0, 5)) {
    try {
      const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
      const cp = page['properties'];
      if (getSelect(cp, 'Status') === 'Active') {
        out.push({ name: getTitle(cp, 'Name'), type: getSelect(cp, 'Type') ?? '', content: getRichText(cp, 'Content') });
      }
    } catch { /* skip unreadable row */ }
  }
  if (out.length > 0) return out;

  // (b) Fallback: the company-wide vision.
  const companyDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'company')).all()[0];
  if (!companyDb) return out;
  try {
    const res = await notionQuery<Record<string, unknown>>(apiKey, companyDb.notionDatabaseId, {
      filter: { and: [
        { property: 'Type', select: { equals: 'Vision' } },
        { property: 'Status', select: { equals: 'Active' } },
      ] },
      page_size: 5,
    });
    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    for (const page of results) {
      const cp = page['properties'];
      out.push({ name: getTitle(cp, 'Name'), type: getSelect(cp, 'Type') ?? '', content: getRichText(cp, 'Content') });
    }
  } catch { /* no fallback if query fails */ }
  return out;
}

export interface PriorComment {
  authorId: string | null;
  /** Resolved Notion display name, when known (so the thread reads naturally). */
  authorName?: string;
  plainText: string;
}

export interface PageRef {
  title: string;
  url: string | null;
  /** True when this agent has never acted on this page before. */
  firstVisit: boolean;
}

/** Assemble the final { system, prompt } message for an agent turn. */
export function buildPrompt(args: {
  ctx: AssembledContext;
  anchor: Anchor;
  priorComments: PriorComment[];
  request: string;
  availableAgents: string[];
  runBlock?: string;
  /** Text of the block a comment is anchored to (inline comments). */
  commentedText?: string;
  /** Where this conversation lives (free pages) so the agent has its bearings. */
  pageRef?: PageRef;
}): { system: string; prompt: string } {
  const { ctx, anchor, priorComments, request, availableAgents, runBlock, commentedText, pageRef } = args;

  // Sections carry a priority (lower = kept first under the budget) and their
  // emission order (for final assembly). priority 0 is never dropped.
  const sections: Section[] = [];
  let order = 0;
  const push = (text: string, priority: number) => { sections.push({ text, priority, order: order++ }); };

  // Where are we? Give free-page conversations their bearings up front.
  if (pageRef) {
    const lines = [
      `[PAGE]`,
      `Title: ${pageRef.title || '(untitled)'}`,
      pageRef.url ? `Link: ${pageRef.url}` : '',
    ].filter(Boolean);
    if (pageRef.firstVisit) {
      lines.push(
        `You haven't worked on this page before. You have only the snippet/thread below; ` +
        `fetch the full page content via your NORC skill (GET <api_base>/page) if you need more.`,
      );
    }
    push(lines.join('\n'), 3);
  }

  // Company-wide context (strategic agents only) — broadest first.
  if (ctx.companyBlocks && ctx.companyBlocks.length > 0) {
    const rows = ctx.companyBlocks
      .map(c => `- ${c.type ? `(${c.type}) ` : ''}${c.name || '(untitled)'}${c.content ? `: ${c.content}` : ''}`)
      .join('\n');
    push(`[STRATEGIC CONTEXT]\n${rows}`, 4);
  }

  if (anchor.kind === 'project' && ctx.projectBlock) {
    push(projectSection(ctx.projectBlock), 3);
  } else if (ctx.projectBlock) {
    push(`[CONTEXT — level: ${ctx.contextLevel}]\n${projectSection(ctx.projectBlock)}`, 3);
  }

  // The linked project's actual written body (task anchors) — where the real
  // material lives when the project row's properties are thin. Bulky → priority 5.
  if (ctx.projectBody && ctx.projectBody.trim()) {
    push(`[PROJECT CONTENT]\n${ctx.projectBody.trim()}`, 5);
  }

  // Addressable sub-pages/databases — small but high-value (the ids that make a
  // named doc fetchable), so a high keep-priority even under budget pressure.
  if (ctx.projectResources && ctx.projectResources.length > 0) {
    const rows = ctx.projectResources
      .map(r => `- ${r.title || '(untitled)'}${r.kind === 'database' ? ' 🗄' : ''} — pageId: ${r.id}`)
      .join('\n');
    push(
      `[PROJECT RESOURCES]\nSub-pages and databases under this project. Fetch any in full with ` +
      `GET <api_base>/page?pageId=<id> (or GET <api_base>/resource?name=<title> to have NORC find it):\n${rows}`,
      2,
    );
  }

  // Resources the request named, pre-fetched — explicitly asked for, so above the
  // generic bodies (5) but below the task/request themselves.
  for (const r of ctx.inlinedResources ?? []) {
    push(
      `[RESOURCE: ${r.title}]\n(pageId: ${r.pageId} — fetch deeper via GET <api_base>/page?pageId=${r.pageId}&depth=5)\n${r.markdown}`,
      4,
    );
  }

  if (ctx.taskBlock) {
    const t = ctx.taskBlock;
    const lines = [
      `[TASK]`,
      `Task: ${t.name || '(untitled)'}`,
      t.status ? `Status: ${t.status}` : '',
      t.kpis ? `Success criteria: ${t.kpis}` : '',
      t.priorOutput ? `Prior agent output: ${t.priorOutput}` : '',
      t.lastCheckpoint ? `Last checkpoint: ${t.lastCheckpoint}` : '',
    ].filter(Boolean);
    push(lines.join('\n'), 1);
  }

  // The page's actual written body — rich but bulky, so a lower priority.
  if (ctx.bodyMarkdown && ctx.bodyMarkdown.trim()) {
    push(`[PAGE CONTENT]\n${ctx.bodyMarkdown.trim()}`, 5);
  }

  // Linked rows (docs, meetings, knowledge) for strategic agents — lowest priority.
  if (ctx.relatedBlocks && ctx.relatedBlocks.length > 0) {
    const rows = ctx.relatedBlocks
      .map(r => `- (${r.relation}) ${r.name || '(untitled)'}${r.id ? ` — pageId: ${r.id}` : ''}${r.summary ? `\n  ${r.summary.replace(/\n/g, '\n  ')}` : ''}`)
      .join('\n');
    push(`[RELATED]\n${rows}`, 6);
  }

  // The exact text the comment is attached to — what the human is reacting to.
  if (commentedText && commentedText.trim()) {
    push(`[COMMENTED-ON TEXT]\nThe comment thread below is attached to this text:\n"""\n${commentedText.trim()}\n"""`, 1);
  }

  if (priorComments.length > 0) {
    const convo = priorComments
      .map(c => `- ${c.authorName ? `${c.authorName}: ` : ''}${c.plainText}`)
      .join('\n');
    push(`[CONVERSATION SO FAR]\n${convo}`, 3);
  }

  push(`[REQUEST]\n${request}`, 0);

  if (availableAgents.length > 0) {
    push(
      `[AVAILABLE AGENTS]\nIf you need another agent, mention them in your reply and NORC will route:\n` +
      availableAgents.map(n => `- ${n}`).join('\n'),
      2,
    );
  }

  // The static protocol lives in the agent's downloaded NORC skill; per task we
  // send only the dynamic run metadata. Essential for the callback → never dropped.
  if (runBlock) push(`[NORC RUN]\n${runBlock}`, 0);

  return { system: ctx.systemPrompt, prompt: assembleWithBudget(sections, MAX_CONTEXT_CHARS) };
}

interface Section { text: string; priority: number; order: number; }

/**
 * Join sections within a character budget. Priority-0 sections are always kept
 * (the request + run contract); the rest are added in priority order until the
 * budget is reached, truncating the overflowing section rather than dropping it
 * silently. Output preserves the original emission order.
 */
function assembleWithBudget(sections: Section[], budget: number): string {
  const byPriority = [...sections].sort((a, b) => a.priority - b.priority || a.order - b.order);
  const kept: Section[] = [];
  let total = 0;
  for (const s of byPriority) {
    const cost = s.text.length + 2;
    if (s.priority === 0 || total + cost <= budget) {
      kept.push(s);
      total += cost;
    } else {
      const room = budget - total - 2;
      if (room > 300) {
        kept.push({ text: `${s.text.slice(0, room)}\n…(truncated for length)`, priority: s.priority, order: s.order });
        total = budget;
      }
      // otherwise drop this section entirely
    }
  }
  return kept.sort((a, b) => a.order - b.order).map(s => s.text).join('\n\n');
}

function projectSection(p: ProjectBlock): string {
  return [
    `Project: ${p.name || '(unnamed)'}`,
    p.objective ? `Objective: ${p.objective}` : '',
    p.kpis ? `KPIs: ${p.kpis}` : '',
    p.docs ? `Docs: ${p.docs}` : '',
  ].filter(Boolean).join('\n');
}
