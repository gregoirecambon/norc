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
import { notionGet } from './notion-client.js';
import { getTitle, getRichText, getSelect, getRelationIds } from './notion-props.js';
import type { Anchor } from './notion-anchor.js';
import type { AgentRef } from './notion-mentions.js';

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

export interface AssembledContext {
  contextLevel: ContextLevel;
  systemPrompt: string;
  taskBlock: TaskBlock | null;
  projectBlock: ProjectBlock | null;
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

  // strategic (company) context arrives in Phase 4.

  const fingerprint = fingerprintOf({ systemPrompt, contextLevel, projectBlock, companyBlock: null });
  return { contextLevel, systemPrompt, taskBlock, projectBlock, fingerprint };
}

export interface PriorComment {
  authorId: string | null;
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
  const sections: string[] = [];

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
    sections.push(lines.join('\n'));
  }

  if (anchor.kind === 'project' && ctx.projectBlock) {
    sections.push(projectSection(ctx.projectBlock));
  } else if (ctx.projectBlock) {
    sections.push(`[CONTEXT — level: ${ctx.contextLevel}]\n${projectSection(ctx.projectBlock)}`);
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
    sections.push(lines.join('\n'));
  }

  // The exact text the comment is attached to — what the human is reacting to.
  if (commentedText && commentedText.trim()) {
    sections.push(`[COMMENTED-ON TEXT]\nThe comment thread below is attached to this text:\n"""\n${commentedText.trim()}\n"""`);
  }

  if (priorComments.length > 0) {
    const convo = priorComments
      .map(c => `- ${c.plainText}`)
      .join('\n');
    sections.push(`[CONVERSATION SO FAR]\n${convo}`);
  }

  sections.push(`[REQUEST]\n${request}`);

  if (availableAgents.length > 0) {
    sections.push(
      `[AVAILABLE AGENTS]\nIf you need another agent, mention them in your reply and NORC will route:\n` +
      availableAgents.map(n => `- ${n}`).join('\n'),
    );
  }

  // The static protocol lives in the agent's downloaded NORC skill; per task we
  // send only the dynamic run metadata.
  if (runBlock) sections.push(`[NORC RUN]\n${runBlock}`);

  return { system: ctx.systemPrompt, prompt: sections.join('\n\n') };
}

function projectSection(p: ProjectBlock): string {
  return [
    `Project: ${p.name || '(unnamed)'}`,
    p.objective ? `Objective: ${p.objective}` : '',
    p.kpis ? `KPIs: ${p.kpis}` : '',
    p.docs ? `Docs: ${p.docs}` : '',
  ].filter(Boolean).join('\n');
}
