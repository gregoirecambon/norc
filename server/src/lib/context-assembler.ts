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
import { readPageMarkdown, type Anchor } from './notion-anchor.js';
import type { AgentRef } from './notion-mentions.js';

// How much written content to inject. The anchor page's own body is the richest
// signal; related rows are summaries. A final budget pass (assembleWithBudget)
// guarantees the whole prompt stays bounded regardless of how deep these go.
const PAGE_BODY_MAX_CHARS = 4000;
const RELATED_SUMMARY_MAX_CHARS = 600;
const MAX_RELATED_ROWS = 8;
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
}

export interface AssembledContext {
  contextLevel: ContextLevel;
  systemPrompt: string;
  taskBlock: TaskBlock | null;
  projectBlock: ProjectBlock | null;
  companyBlocks: CompanyBlock[];
  relatedBlocks: RelatedBlock[];
  /** The anchor page's actual written body (markdown-ish), not just properties. */
  bodyMarkdown: string;
  fingerprint: string;
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
}): Promise<AssembledContext> {
  const { apiKey, anchor, agentRef } = args;

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

  // Deeper strategic relations — follow the project's other relations (Docs,
  // Knowledge, Meetings, …) so a strategic agent sees the linked material, not
  // just Company/Vision rows. Gated to `strategic` to keep narrower agents lean.
  const relatedBlocks = contextLevel === 'strategic'
    ? await resolveRelatedBlocks(apiKey, projectProps)
    : [];

  // The anchor page's actual written content — the single biggest context gain.
  // Best-effort: an unreadable body just yields properties-only context.
  let bodyMarkdown = '';
  try {
    bodyMarkdown = (await readPageMarkdown(apiKey, anchor.pageId, PAGE_BODY_MAX_CHARS)).trim();
  } catch { /* body is best-effort */ }

  const fingerprint = fingerprintOf({ systemPrompt, contextLevel, projectBlock, companyBlocks, relatedBlocks, bodyMarkdown });
  return { contextLevel, systemPrompt, taskBlock, projectBlock, companyBlocks, relatedBlocks, bodyMarkdown, fingerprint };
}

// Project relations handled elsewhere (Company → strategic layer) or irrelevant
// as context (Agents → the roster, not material).
const SKIP_RELATIONS = new Set(['Company', 'Agents']);

/**
 * Walk the project's relation properties (other than Company/Agents) and pull a
 * short body snippet of each linked row — meeting notes, docs, knowledge, etc.
 * Best-effort and capped (per relation and overall) so deep graphs stay bounded.
 */
async function resolveRelatedBlocks(apiKey: string, projectProps: unknown): Promise<RelatedBlock[]> {
  if (!projectProps || typeof projectProps !== 'object') return [];
  const props = projectProps as Record<string, unknown>;
  const out: RelatedBlock[] = [];

  for (const [propName, val] of Object.entries(props)) {
    if (SKIP_RELATIONS.has(propName)) continue;
    if (!val || typeof val !== 'object' || (val as Record<string, unknown>)['type'] !== 'relation') continue;
    const ids = getRelationIds(props, propName);
    for (const id of ids.slice(0, 3)) {
      try {
        const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
        const name = getAnyTitle(page['properties']);
        const summary = (await readPageMarkdown(apiKey, id, RELATED_SUMMARY_MAX_CHARS, 1)).trim();
        out.push({ relation: propName, name, summary });
        if (out.length >= MAX_RELATED_ROWS) return out;
      } catch { /* skip unreadable row */ }
    }
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
      .map(r => `- (${r.relation}) ${r.name || '(untitled)'}${r.summary ? `\n  ${r.summary.replace(/\n/g, '\n  ')}` : ''}`)
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
