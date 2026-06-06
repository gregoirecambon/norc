// The orchestration pipeline: webhook event → mention → context → dispatch → reply.
//
// Triggers are detected ANYWHERE in Notion:
//   - comment.created      → mentions in the comment's rich_text  (chat turn)
//   - page.created / .properties_updated / .content_updated
//                          → mentions in property values (relations like
//                            "Assigned To", plus title/rich_text) AND block
//                            content. On a Task, this is a work assignment.
//
// For each matched agent NORC assembles context (gated by the agent's Context
// Level), dispatches synchronously, posts the reply, and — for task work —
// drives the Status lifecycle (write-FIRST In Progress, then Done/Failed). Every
// decision point logs its disposition for the Logs feed.

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration, notionDatabases, orchestratorComments, processedTriggers } from '../db/schema.js';
import type { AdapterType } from '../types.js';
import { emitLog } from './logger.js';
import { emitEvent } from './events.js';
import {
  extractMentionedPageIds,
  extractRelationPageIds,
  extractPropertyMentionPageIds,
  matchAgents,
  type AgentRef,
} from './notion-mentions.js';
import { resolveAnchor, listThreadComments, collectBlockMentionPageIds, readBlockText, userDisplayName, type Anchor, type ThreadComment } from './notion-anchor.js';
import { getAnyTitle, getRelationIds } from './notion-props.js';
import { assembleContext, buildPrompt, type PageRef } from './context-assembler.js';
import { dispatch, dispatchSupported } from '../adapters/index.js';
import { createRun, getRun, finalizeRun, hasPriorRunOnPage, timedOutAgentIdsForPage, type TaskRun } from './runs.js';
import { getNorcSettings } from './norc-settings.js';
import { triage, assessOutcome, classifyTaskWorthy, type TriageCandidate } from './orchestrator-agent.js';
import {
  postComment, postCommentReply, postCommentMentioning, postCommentReplyMentioning,
  postCommentRich, postCommentReplyRich, type RichSeg, appendBlocks,
  setTaskStatus, setTaskAssignee, setTaskFields, setAgentStatus, touchLastActive, createTaskPage,
} from './notion-writeback.js';
import { markdownToBlocks } from './notion-blocks-md.js';

function norcBaseUrl(): string {
  return process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;
}

/**
 * The compact per-task run block. The static protocol (how to use the API) lives
 * in the agent's downloaded NORC skill; here we send only the dynamic bits the
 * agent needs to report back — including the Notion page/task id.
 */
function runBlock(runId: string, token: string, pageId: string, discussionId?: string | null): string {
  const lines = [
    `run_id: ${runId}`,
    `notion_page_id: ${pageId}`,
  ];
  // When the trigger was a comment, give the agent the discussion to reply into
  // so its comment lands on the precise text rather than the page.
  if (discussionId) lines.push(`reply_discussion_id: ${discussionId}`);
  lines.push(`api_base: ${norcBaseUrl()}/api/runs/${token}`);
  lines.push(`Use your NORC skill to act/report. Don't have it? GET ${norcBaseUrl()}/api/skill`);
  return lines.join('\n');
}

/**
 * Heuristic: does this request ask the agent to *produce content* (which belongs
 * inside the page as blocks) versus just respond/discuss (which belongs in a
 * comment on the text)? Used only for non-task pages.
 */
const CONTENT_REQUEST = /\b(write|draft|create|produce|generate|compose|outline|document|summari[sz]e|rewrite|expand|fill in|add (?:a |the |some )?(?:section|paragraph|note|content|page)|rédige|écris|écri[ts]|crée|génère|produis|résume|complète|ajoute)\b/i;
export function wantsContent(request: string): boolean {
  return CONTENT_REQUEST.test(request);
}

interface NotionWebhookEvent {
  type?: string;
  entity?: { id?: string; type?: string };
  data?: { page_id?: string; parent?: { id?: string; type?: string } };
  authors?: { id?: string; type?: string }[];
}

type Integration = typeof notionIntegration.$inferSelect;

const PAGE_EVENT_TYPES = new Set([
  'page.created',
  'page.properties_updated',
  'page.content_updated',
]);

const RAW_LOG_LIMIT = 2_000;

function safeJson(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    if (!s) return '';
    return s.length > RAW_LOG_LIMIT ? `${s.slice(0, RAW_LOG_LIMIT)}…(truncated)` : s;
  } catch {
    return '';
  }
}

function alreadyProcessed(key: string): boolean {
  return !!db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, key)).all()[0];
}

function markProcessed(key: string): void {
  db.insert(processedTriggers).values({ triggerKey: key, createdAt: Date.now() }).onConflictDoNothing().run();
}

/** Run a Notion write-back, logging (but never throwing) on failure. */
async function safeWrite(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    emitLog(`write-back error (${label}): ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

/** Record a NORC-authored comment id so we don't re-trigger on our own comment. */
function recordOurComment(commentId: string): void {
  if (commentId) {
    db.insert(orchestratorComments).values({ commentId, createdAt: Date.now() }).onConflictDoNothing().run();
  }
}

/** Post a page-level NORC comment and record its id so we don't re-trigger on it.
 * When mentionUserId is set, the comment opens with a real @user mention so that
 * person gets a Notion notification (used to pull a human in when triage is unsure). */
async function postAgentComment(apiKey: string, pageId: string, text: string, mentionUserId?: string | null): Promise<void> {
  const res = mentionUserId
    ? await postCommentMentioning(apiKey, pageId, mentionUserId, text)
    : await postComment(apiKey, pageId, text);
  recordOurComment(res.commentId);
}

/** Reply on the precise text (into a discussion) and record the comment id. */
async function postAgentReply(apiKey: string, discussionId: string, text: string, mentionUserId?: string | null): Promise<void> {
  const res = mentionUserId
    ? await postCommentReplyMentioning(apiKey, discussionId, mentionUserId, text)
    : await postCommentReply(apiKey, discussionId, text);
  recordOurComment(res.commentId);
}

/** Post NORC rich content (real @mentions of agents/tasks) to a thread or page. */
async function postAgentRich(apiKey: string, anchorPageId: string, discussionId: string | null | undefined, segs: RichSeg[]): Promise<void> {
  const res = discussionId
    ? await postCommentReplyRich(apiKey, discussionId, segs)
    : await postCommentRich(apiKey, anchorPageId, segs);
  recordOurComment(res.commentId);
}

/**
 * Deliver an agent's reply to the right place for a NON-task page:
 *   - "produce content" requests  → write the result into the page as blocks
 *   - otherwise, with a discussion → reply on the precise text (threaded)
 *   - otherwise                    → page-level comment (last resort)
 * Tasks keep their own comment/Agent-Output handling in runAgentTurn.
 */
async function deliverPageReply(
  apiKey: string,
  anchor: Anchor,
  opts: TurnOpts,
  agentName: string,
  text: string,
): Promise<void> {
  if (wantsContent(opts.request)) {
    const blocks = markdownToBlocks(text);
    await safeWrite('append content', () => appendBlocks(apiKey, anchor.pageId, blocks));
    emitLog(`"${agentName}" wrote ${blocks.length} block(s) into ${anchor.kind} page ${anchor.pageId}`);
    // Let the human know on the thread it was triggered from.
    if (opts.discussionId) {
      await safeWrite('reply note', () =>
        postAgentReply(apiKey, opts.discussionId!, `**@${agentName}** added this to the page above ↑`));
    }
    return;
  }
  if (opts.discussionId) {
    await safeWrite('reply on text', () => postAgentReply(apiKey, opts.discussionId!, `**@${agentName}**\n\n${text}`));
    return;
  }
  await safeWrite('page comment', () => postAgentComment(apiKey, anchor.pageId, `**@${agentName}**\n\n${text}`));
}

/**
 * Process one Notion webhook event. Fire-and-forget: never throws (the route has
 * already returned 200); all failures are logged.
 */
export async function processWebhookEvent(raw: unknown): Promise<void> {
  const event = (raw ?? {}) as NotionWebhookEvent;
  const type = event.type ?? 'unknown';
  const entityId = event.entity?.id ?? '—';

  emitLog(`webhook received: type=${type} entity=${entityId}`);
  const rawJson = safeJson(raw);
  if (rawJson) emitLog(`webhook payload: ${rawJson}`);

  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') {
    emitLog('webhook ignored: Notion integration not active');
    return;
  }

  // Loop guard — ignore anything authored by our own integration bot.
  const authorIds = (event.authors ?? [])
    .map(a => a?.id)
    .filter((id): id is string => typeof id === 'string');
  if (integration.botUserId && authorIds.includes(integration.botUserId)) {
    emitLog('webhook ignored: authored by NORC bot (loop guard)');
    return;
  }

  // The human who triggered this event (no bot here — loop guard returned above).
  const triggeringUserId = authorIds[0] ?? null;

  try {
    if (event.type === 'comment.created') {
      await handleCommentEvent(integration, event, triggeringUserId);
    } else if (event.type && PAGE_EVENT_TYPES.has(event.type)) {
      await handlePageEvent(integration, event, triggeringUserId);
    } else {
      emitLog(`webhook ignored: "${type}" is not a trigger event type`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    emitLog(`orchestrator error handling ${type}: ${msg}`);
  }
}

/** comment.created — a conversational turn; mentions live in the comment text. */
async function handleCommentEvent(integration: Integration, event: NotionWebhookEvent, triggeringUserId: string | null): Promise<void> {
  const apiKey = integration.apiKey;
  const commentId = event.entity?.id;
  if (!commentId) {
    emitLog('webhook ignored: comment event carries no comment id');
    return;
  }
  if (db.select().from(orchestratorComments).where(eq(orchestratorComments.commentId, commentId)).all()[0]) {
    emitLog(`webhook ignored: comment ${commentId} was authored by NORC (loop guard)`);
    return;
  }
  const triggerKey = `comment:${commentId}`;
  if (alreadyProcessed(triggerKey)) {
    emitLog(`webhook ignored: comment ${commentId} already processed`);
    return;
  }
  // A comment's parent may be the page (page-level thread) OR a block (an inline
  // comment anchored to a specific text). The page the conversation belongs to is
  // carried separately in data.page_id; the parent id is where the discussion is
  // anchored — list the thread there so inline comments are found, and reply there
  // so our answer lands on the exact text.
  const parent = event.data?.parent;
  const threadBlockId = parent?.id;
  const pageId = event.data?.page_id ?? (parent?.type === 'page' ? parent?.id : undefined);
  if (!threadBlockId || !pageId) {
    emitLog(`webhook ignored: comment ${commentId} has no resolvable page/parent`);
    return;
  }

  const thread = await listThreadComments(apiKey, threadBlockId);
  const triggering = thread.find(c => c.id === commentId);
  const matched = matchAgents(extractMentionedPageIds(triggering?.richText ?? []));
  if (matched.length === 0) {
    const anchor = await resolveAnchor(apiKey, pageId);
    const commentedText = parent?.type === 'block' ? await readBlockText(apiKey, threadBlockId) : '';
    const handled = await triageUnhandled(integration, anchor, {
      text: (triggering?.plainText ?? '').trim(),
      thread, discussionId: triggering?.discussionId ?? null, commentedText, dedupId: commentId,
      triggeringUserId: triggering?.authorId ?? triggeringUserId,
    });
    if (!handled) emitLog(`webhook discarded: no agent mentioned in comment on page ${pageId}`);
    return;
  }

  const anchor = await resolveAnchor(apiKey, pageId);
  markProcessed(triggerKey);
  const onText = parent?.type === 'block' ? ' (on text)' : '';
  emitLog(`mention detected in comment on ${anchor.kind} page ${pageId}${onText}: ${matched.map(a => a.name).join(', ')}`);

  // For an inline comment, fetch the text it's anchored to so the agent knows
  // exactly what the human is reacting to.
  const commentedText = parent?.type === 'block' ? await readBlockText(apiKey, threadBlockId) : '';

  const request = (triggering?.plainText ?? '').trim() || 'Please respond.';
  for (const agent of matched) {
    // A comment is a chat turn — reply, but don't drive task Status.
    await runAgentTurn(integration, anchor, agent, {
      thread, request, triggeringCommentId: commentId,
      discussionId: triggering?.discussionId ?? null, commentedText,
      triggeringUserId: triggering?.authorId ?? triggeringUserId,
      manageTaskStatus: false, how: 'comment mention',
    });
  }

  // The agent answered the comment; if this was actual WORK (not just a question)
  // on a non-task surface, also spin up a tracked task and route it.
  if (anchor.kind !== 'task') {
    await maybeCreateTaskFromWork(integration, anchor, request,
      triggering?.discussionId ?? null, triggering?.authorId ?? triggeringUserId);
  }
}

/**
 * When an agent is asked to DO something on a non-task page (a real work request,
 * not just a question), create a tracked Backlog task, note it on the thread with
 * a real @link, and triage it (assign + @mention) — so off-task work still becomes
 * a managed task. Task-worthiness is judged by the Triage LLM (fallback: the
 * wantsContent heuristic). No-op for questions/feedback.
 */
async function maybeCreateTaskFromWork(
  integration: Integration, anchor: Anchor, request: string,
  discussionId: string | null, triggeringUserId: string | null,
): Promise<void> {
  if (anchor.kind === 'task' || !request.trim()) return;
  const settings = getNorcSettings();
  const apiKey = integration.apiKey;

  let title = '';
  let kpis: string | undefined;
  if (triageConfigured(settings)) {
    try {
      const cls = await classifyTaskWorthy({
        provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
        apiKey: settings!.orchestratorApiKey ?? '', baseUrl: settings!.orchestratorBaseUrl, model: settings!.orchestratorModel,
        kind: anchor.kind, title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']), text: request,
      });
      if (!cls.task) return;
      title = cls.title?.trim() || request.slice(0, 80);
      kpis = cls.kpis?.trim() || undefined;
    } catch (err) { emitLog(`task-from-work: classify failed: ${err instanceof Error ? err.message : 'unknown'}`); return; }
  } else {
    if (!wantsContent(request)) return;
    title = request.slice(0, 80);
  }

  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) { emitLog('task-from-work skipped: no tasks DB provisioned'); return; }
  const projectId = anchor.kind === 'project' ? anchor.pageId : null;

  let pageId = '';
  try {
    ({ pageId } = await createTaskPage(apiKey, tasksDb.notionDatabaseId, { title, kpis: kpis ?? '', projectId }));
  } catch (err) { emitLog(`task-from-work: create failed: ${err instanceof Error ? err.message : 'unknown'}`); return; }
  await safeWrite('task body', () => appendBlocks(apiKey, pageId, markdownToBlocks(request)));
  markProcessed(`triage:${pageId}`); // a creation webhook must not re-triage it
  emitLog(`task-from-work: created "${title}" (${pageId}) from ${anchor.kind} ${anchor.pageId}`);

  // Tell the thread, with a real @link to the new task.
  await postAgentRich(apiKey, anchor.pageId, discussionId, [
    `🧭 **NORC Triage Agent**\nI turned this into a task: `, { pageId }, ` — routing it now.`,
  ]);

  // Assign/route the new task (sets Assigned To + real @mention via M1/M2).
  try {
    const taskAnchor = await resolveAnchor(apiKey, pageId);
    await runTriage(integration, taskAnchor, { text: request, thread: [], triggeringUserId }, [], '');
  } catch (err) { emitLog(`task-from-work: triage failed: ${err instanceof Error ? err.message : 'unknown'}`); }
}

/** page.* — mentions in property values / block content. On a Task = work. */
async function handlePageEvent(integration: Integration, event: NotionWebhookEvent, triggeringUserId: string | null): Promise<void> {
  const apiKey = integration.apiKey;
  const pageId = event.entity?.id;
  if (!pageId) {
    emitLog('webhook ignored: page event carries no page id');
    return;
  }

  const anchor = await resolveAnchor(apiKey, pageId);
  const properties = (anchor.page as Record<string, unknown>)['properties'];
  const candidateIds = [
    ...extractRelationPageIds(properties),
    ...extractPropertyMentionPageIds(properties),
    ...await collectBlockMentionPageIds(apiKey, pageId),
  ];

  const matched = matchAgents(candidateIds);
  if (matched.length === 0) {
    const thread = await listThreadComments(apiKey, pageId);
    const handled = await triageUnhandled(integration, anchor, { text: '', thread, dedupId: pageId, triggeringUserId });
    if (!handled) emitLog(`webhook discarded: no agent referenced on ${anchor.kind} page ${pageId}`);
    return;
  }

  // Per-(page, agent) idempotency so repeated edits don't re-fire.
  const fresh = matched.filter(a => !alreadyProcessed(`page:${pageId}:${a.agentId}`));
  if (fresh.length === 0) {
    emitLog(`webhook ignored: ${anchor.kind} page ${pageId} already handled for ${matched.map(a => a.name).join(', ')}`);
    return;
  }

  const thread = await listThreadComments(apiKey, pageId);
  emitLog(`mention detected on ${anchor.kind} page ${pageId}: ${fresh.map(a => a.name).join(', ')}`);
  for (const agent of fresh) {
    markProcessed(`page:${pageId}:${agent.agentId}`);
    const request = anchor.kind === 'task'
      ? 'You have been assigned to this task. Complete it using the context above and report your result.'
      : `You were referenced on this ${anchor.kind}. Respond using the context above.`;
    await runAgentTurn(integration, anchor, agent, {
      thread, request, triggeringUserId,
      manageTaskStatus: anchor.kind === 'task', how: anchor.kind === 'task' ? 'assignment' : 'page mention',
    });
  }
}

/** Resolve an agent name (as the orchestrator returned it) to a dispatchable ref. */
function matchAgentByName(name: string): AgentRef | null {
  const norm = name.replace(/^@/, '').trim().toLowerCase();
  const row = db.select().from(agents).all().find(a => a.name.toLowerCase() === norm);
  if (!row || !row.orgDbPageId) return null;
  return { agentId: row.id, orgDbPageId: row.orgDbPageId, name: row.name, adapterType: row.adapterType };
}

interface TriageOpts {
  text: string;
  thread: ThreadComment[];
  discussionId?: string | null;
  commentedText?: string;
  dedupId: string;
  /** Notion user id that triggered the event — @mentioned when triage is unsure. */
  triggeringUserId?: string | null;
}

/**
 * The NORC Triage Agent (co-CEO): when no agent was matched, decide whether to
 * auto-route to the best agent (high confidence) or suggest one to the human.
 * Returns true when it took ownership of the event (so the caller skips the
 * generic "discarded" log). No-op (returns false) when disabled / no agents.
 */
function triageConfigured(settings: ReturnType<typeof getNorcSettings>): boolean {
  if (!settings?.orchestratorEnabled) return false;
  // anthropic needs a key; openai (LiteLLM) needs a base URL (key optional).
  return settings.orchestratorProvider === 'openai' ? !!settings.orchestratorBaseUrl : !!settings.orchestratorApiKey;
}

/** The agent roster (name/specialty/capabilities/technology) for triage/assessment,
 * excluding the given names. Mirrors the Org DB metadata the agents registered with. */
function rosterCandidates(excludeNames: string[]): TriageCandidate[] {
  const excl = new Set(excludeNames.map(n => n.toLowerCase()));
  return db.select().from(agents).all().filter(a => !excl.has(a.name.toLowerCase())).map(a => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(a.metadata); } catch { /* */ }
    return {
      name: a.name,
      specialty: typeof meta['specialty'] === 'string' ? meta['specialty'] : (typeof meta['role'] === 'string' ? meta['role'] : ''),
      capabilities: typeof meta['capabilities'] === 'string' ? meta['capabilities'] : '',
      technology: typeof meta['technology'] === 'string' ? meta['technology'] : '',
    };
  });
}

async function triageUnhandled(integration: Integration, anchor: Anchor, opts: TriageOpts): Promise<boolean> {
  if (!triageConfigured(getNorcSettings())) return false;

  const dedupKey = `triage:${opts.dedupId}`;
  if (alreadyProcessed(dedupKey)) return true; // already triaged — don't re-fire or re-log
  markProcessed(dedupKey);

  if (db.select().from(agents).all().length === 0) { emitLog('triage skipped: no agents registered'); return false; }

  await runTriage(integration, anchor, {
    text: opts.text, thread: opts.thread, discussionId: opts.discussionId, commentedText: opts.commentedText,
    triggeringUserId: opts.triggeringUserId,
  }, [], '');
  return true;
}

interface TriageCtx {
  text: string;
  thread: ThreadComment[];
  discussionId?: string | null;
  commentedText?: string;
  /** Notion user id to @mention when triage is unsure (needs a human). */
  triggeringUserId?: string | null;
}

export type TriageOutcome = 'routed' | 'suggested' | 'asked' | 'no-agents' | 'error' | 'disabled';

/** The Notion user who created a page (fallback @mention target on escalation). */
function pageCreatedById(page: Record<string, unknown>): string | null {
  const cb = page['created_by'] as Record<string, unknown> | undefined;
  return cb && typeof cb['id'] === 'string' ? cb['id'] : null;
}

/**
 * Run the Triage Agent and apply its decision. Always communicates in Notion
 * (route → tag + explain then dispatch; suggest/ignore → ask). `excludeNames`
 * drops agents from the roster (used on re-routing after a timeout, so a failed
 * agent isn't picked again). `notePrefix` is prepended to every message.
 */
async function runTriage(integration: Integration, anchor: Anchor, ctx: TriageCtx, excludeNames: string[], notePrefix: string): Promise<TriageOutcome> {
  const settings = getNorcSettings();
  if (!triageConfigured(settings)) return 'disabled';
  const apiKey = integration.apiKey;
  const prefix = notePrefix ? `${notePrefix}\n\n` : '';

  // When `mention` is true and we know who triggered the event, the comment opens
  // with a real @user mention so that person gets a Notion notification — the
  // native way to pull a human in when triage is unsure.
  const announce = async (text: string, mention = false) => {
    const full = `🧭 **NORC Triage Agent**\n${prefix}${text}`;
    const who = mention ? (ctx.triggeringUserId ?? null) : null;
    if (ctx.discussionId) await safeWrite('triage reply', () => postAgentReply(apiKey, ctx.discussionId!, full, who));
    else await safeWrite('triage comment', () => postAgentComment(apiKey, anchor.pageId, full, who));
  };

  const excl = new Set(excludeNames.map(n => n.toLowerCase()));
  const agentRows = db.select().from(agents).all().filter(a => !excl.has(a.name.toLowerCase()));
  if (agentRows.length === 0) {
    await announce('No remaining agents to try — please assign someone manually, or tell me to investigate.', true);
    emitLog('triage: no remaining agents after exclusions');
    return 'no-agents';
  }

  const candidates = agentRows.map(a => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(a.metadata); } catch { /* */ }
    return {
      name: a.name,
      specialty: typeof meta['specialty'] === 'string' ? meta['specialty'] : (typeof meta['role'] === 'string' ? meta['role'] : ''),
      capabilities: typeof meta['capabilities'] === 'string' ? meta['capabilities'] : '',
      technology: typeof meta['technology'] === 'string' ? meta['technology'] : '',
    };
  });
  const title = getAnyTitle((anchor.page as Record<string, unknown>)['properties']);
  const conversation = ctx.thread
    .filter(c => c.authorId !== integration.botUserId)
    .map(c => c.plainText)
    .filter(t => t.trim().length > 0);

  emitLog(`triage: NORC Triage Agent analyzing unassigned ${anchor.kind} ${anchor.pageId}${excludeNames.length ? ` (excluding: ${excludeNames.join(', ')})` : ''}`);
  let decision;
  try {
    decision = await triage({
      provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
      apiKey: settings!.orchestratorApiKey ?? '',
      baseUrl: settings!.orchestratorBaseUrl,
      model: settings!.orchestratorModel,
      systemPrompt: settings!.orchestratorSystemPrompt ?? undefined,
      kind: anchor.kind, title, text: ctx.text,
      commentedText: ctx.commentedText, conversation, candidates,
    });
  } catch (err) {
    emitLog(`triage error: ${err instanceof Error ? err.message : 'unknown'}`);
    await announce('I hit an error deciding who should take this — please assign someone manually.');
    return 'error';
  }

  if (decision.decision === 'ignore') {
    const msg = decision.message?.trim() || 'No one is assigned and no registered agent clearly fits this. Who should take it?';
    await announce(msg, true);
    emitLog(`triage: no clear owner (${decision.message || 'asked'})`);
    return 'asked';
  }

  const routed = decision.agent ? matchAgentByName(decision.agent) : null;
  if (decision.decision === 'route' && routed && decision.confidence >= settings!.autoRouteThreshold) {
    emitLog(`triage: auto-routing to "${routed.name}" (confidence ${decision.confidence.toFixed(2)})`);
    const why = decision.message?.trim() || `No one was assigned, so I'm routing this.`;
    // Real @mention of the agent's Org DB page (clickable, not plain text).
    await postAgentRich(apiKey, anchor.pageId, ctx.discussionId, [
      `🧭 **NORC Triage Agent**\n${prefix}${why}\n\nRouting to `,
      { pageId: routed.orgDbPageId },
      ` now — reply here to redirect.`,
    ]);
    await runAgentTurn(integration, anchor, routed, {
      thread: ctx.thread,
      request: ctx.text || 'The NORC Triage Agent routed this to you. Handle it using the context above.',
      discussionId: ctx.discussionId, commentedText: ctx.commentedText,
      triggeringUserId: ctx.triggeringUserId,
      manageTaskStatus: anchor.kind === 'task', how: 'orchestrator auto-route',
    });
    return 'routed';
  }

  // Suggest (or "route" below threshold): ask the human to confirm — tag the human
  // and, when we resolved a candidate, @mention the agent's page too.
  emitLog(`triage: suggested ${decision.agent ?? 'none'} (confidence ${decision.confidence.toFixed(2)})`);
  if (routed) {
    const why = decision.message?.trim() || 'No one is assigned.';
    const segs: RichSeg[] = [];
    if (ctx.triggeringUserId) segs.push({ userId: ctx.triggeringUserId }, ' ');
    segs.push(`🧭 **NORC Triage Agent**\n${prefix}${why} I think `, { pageId: routed.orgDbPageId }, ` could handle this — reply "@${routed.name} go" to assign.`);
    await postAgentRich(apiKey, anchor.pageId, ctx.discussionId, segs);
    return 'suggested';
  }
  await announce(decision.message?.trim() || 'No one is assigned and no registered agent clearly fits. Who should take this?', true);
  return 'suggested';
}

/**
 * A dispatched run never reported back in time. Free the agent, tell the team in
 * Notion, and (if triage is on) re-route to a DIFFERENT agent — excluding every
 * agent that has already timed out on this page, so it won't keep picking a dead
 * one. When all agents are exhausted it asks a human.
 */
export async function escalateTimedOutRun(run: TaskRun): Promise<void> {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') return;
  const apiKey = integration.apiKey;

  const dedupKey = `timeout:${run.id}`;
  if (alreadyProcessed(dedupKey)) return;
  markProcessed(dedupKey);

  const agentRow = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];
  const agentName = agentRow?.name ?? run.agentId;

  // Free the agent + revert task status so the work isn't stuck "In Progress".
  if (agentRow?.orgDbPageId) await safeWrite('agent available', () => setAgentStatus(apiKey, agentRow.orgDbPageId!, 'Available'));
  const taskPageId = run.taskPageId;
  if (run.manageTaskStatus && taskPageId) await safeWrite('task backlog', () => setTaskStatus(apiKey, taskPageId, 'Backlog'));

  emitLog(`run ${run.id} timed out — "${agentName}" didn't report back; escalating`);
  emitEvent({ type: 'mention.detected', data: { agentId: run.agentId, agentName, pageId: run.pageId, anchorKind: run.anchorKind } });

  let anchor: Anchor;
  try {
    anchor = await resolveAnchor(apiKey, run.pageId);
  } catch {
    await safeWrite('timeout note', () => postAgentComment(apiKey, run.pageId,
      `🧭 **NORC Triage Agent**\n⏱ **@${agentName}** didn't respond in time and I can't re-read this page. Please reassign.`,
      run.triggeringUserId));
    return;
  }

  // Who to pull in: the original trigger, else the page's creator.
  const mentionUser = run.triggeringUserId ?? pageCreatedById(anchor.page as Record<string, unknown>);
  const prefix = `⏱ **@${agentName}** didn't respond within the timeout. Want me to hand this to someone else, or should I dig into what's wrong?`;

  if (!triageConfigured(getNorcSettings())) {
    await safeWrite('timeout note', () => postAgentComment(apiKey, run.pageId, `🧭 **NORC Triage Agent**\n${prefix}`, mentionUser));
    return;
  }

  const thread = await listThreadComments(apiKey, run.pageId).catch(() => [] as ThreadComment[]);
  const excludeIds = new Set(timedOutAgentIdsForPage(run.pageId));
  const excludeNames = db.select().from(agents).all().filter(a => excludeIds.has(a.id)).map(a => a.name);
  await runTriage(integration, anchor, { text: '', thread, triggeringUserId: mentionUser }, excludeNames, prefix);
}

export interface ProposedTask {
  title: string;
  description?: string;
  kpis?: string;
}

/**
 * An agent (e.g. a company-brain after a planning discussion) hands NORC a list of
 * follow-up tasks. For each: create a Backlog row in the Tasks DB (linked to the
 * proposing run's project when there is one), then triage it — auto-route when
 * confident, otherwise ask the human in Notion + email. Posts one summary comment
 * on the source page and returns each task's id + disposition.
 */
export async function proposeTasks(opts: {
  sourcePageId: string;
  proposerName?: string;
  tasks: ProposedTask[];
}): Promise<{ created: { id: string; title: string; disposition: TriageOutcome | 'created' }[] }> {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') throw new Error('notion integration not active');
  const apiKey = integration.apiKey;

  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) throw new Error('no tasks database provisioned');

  // Link new tasks to the project the proposing run is anchored to (if any).
  let projectId: string | null = null;
  try {
    const src = await resolveAnchor(apiKey, opts.sourcePageId);
    if (src.kind === 'project') projectId = src.pageId;
    else if (src.kind === 'task') projectId = getRelationIds((src.page as Record<string, unknown>)['properties'], 'Project')[0] ?? null;
  } catch { /* no project link */ }

  const created: { id: string; title: string; disposition: TriageOutcome | 'created' }[] = [];
  for (const t of opts.tasks) {
    const title = t.title.trim();
    if (!title) continue;
    let pageId = '';
    try {
      ({ pageId } = await createTaskPage(apiKey, tasksDb.notionDatabaseId, { title, kpis: t.kpis, projectId }));
    } catch (err) {
      emitLog(`propose-tasks: failed to create "${title}": ${err instanceof Error ? err.message : 'error'}`);
      continue;
    }
    // Put the description in the task body so the assigned agent sees it as content.
    if (t.description && t.description.trim()) {
      await safeWrite('task description', () => appendBlocks(apiKey, pageId, markdownToBlocks(t.description!.trim())));
    }
    // A creation webhook on this fresh page must not re-trigger triage.
    markProcessed(`triage:${pageId}`);

    let disposition: TriageOutcome | 'created' = 'created';
    if (triageConfigured(getNorcSettings())) {
      try {
        const anchor = await resolveAnchor(apiKey, pageId);
        disposition = await runTriage(integration, anchor, { text: t.description?.trim() || title, thread: [] }, [], '');
      } catch (err) {
        emitLog(`propose-tasks: triage failed for "${title}": ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    created.push({ id: pageId, title, disposition });
    emitLog(`propose-tasks: created "${title}" (${pageId}) → ${disposition}`);
  }

  // Summarize on the source page so the human sees what the agent spun up.
  if (created.length > 0) {
    const lines = created.map(c => `- ${c.title} — ${dispositionLabel(c.disposition)}`).join('\n');
    const who = opts.proposerName ? `**@${opts.proposerName}**` : 'An agent';
    await safeWrite('propose summary', () => postAgentComment(apiKey, opts.sourcePageId,
      `🧭 **NORC Triage Agent**\n${who} proposed ${created.length} task${created.length === 1 ? '' : 's'}:\n${lines}`));
  }

  return { created };
}

/**
 * Dispatch a due scheduled task: if it has an "Assigned To" agent, run that agent;
 * otherwise let the Triage Agent route it (assign + @mention). `occurrenceKey`
 * stabilizes triage dedup for this occurrence.
 */
export async function dispatchScheduledTask(integration: Integration, taskPageId: string, how: string, occurrenceKey: string): Promise<void> {
  const apiKey = integration.apiKey;
  let anchor: Anchor;
  try { anchor = await resolveAnchor(apiKey, taskPageId); } catch (err) {
    emitLog(`scheduler: can't read task ${taskPageId}: ${err instanceof Error ? err.message : 'error'}`);
    return;
  }
  const props = (anchor.page as Record<string, unknown>)['properties'];
  const matched = matchAgents(getRelationIds(props, 'Assigned To'));
  if (matched.length) {
    const request = 'This scheduled task is now due. Complete it using the context above and report your result.';
    for (const agent of matched) {
      await runAgentTurn(integration, anchor, agent, { thread: [], request, manageTaskStatus: true, how });
    }
    return;
  }
  // No assignee → triage assigns/asks.
  await triageUnhandled(integration, anchor, { text: getAnyTitle(props), thread: [], dedupId: occurrenceKey });
}

function dispositionLabel(d: TriageOutcome | 'created'): string {
  switch (d) {
    case 'routed': return 'created & routed to an agent';
    case 'suggested': return 'created — suggested an agent, awaiting your confirmation';
    case 'asked': return 'created — no clear owner, asked the team';
    case 'no-agents': return 'created — no agents available';
    case 'error': return 'created — triage error';
    case 'disabled': return 'created (triage off)';
    default: return 'created';
  }
}

interface TurnOpts {
  thread: ThreadComment[];
  request: string;
  triggeringCommentId?: string;
  /** Discussion to reply into (so the comment lands on the precise text). */
  discussionId?: string | null;
  /** Text the triggering comment is anchored to (inline comments). */
  commentedText?: string;
  /** The human who triggered this turn — persisted on the run for timeout escalation. */
  triggeringUserId?: string | null;
  manageTaskStatus: boolean;
  how: string;
}

/** Assemble context, dispatch (with a run token + contract), reply, drive status. */
async function runAgentTurn(integration: Integration, anchor: Anchor, agentRef: AgentRef, opts: TurnOpts): Promise<void> {
  const apiKey = integration.apiKey;
  const agentRow = db.select().from(agents).where(eq(agents.id, agentRef.agentId)).all()[0];
  if (!agentRow) {
    emitLog(`dispatch skipped: agent "${agentRef.name}" no longer registered`);
    return;
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(agentRow.adapterConfig); } catch { config = {}; }
  const adapterType = agentRow.adapterType as AdapterType;

  emitEvent({
    type: 'mention.detected',
    data: { agentId: agentRef.agentId, agentName: agentRef.name, pageId: anchor.pageId, anchorKind: anchor.kind },
  });

  const ctx = await assembleContext({ apiKey, anchor, agentRef });

  // Exclude NORC's own comments from the conversation. The botUserId check is the
  // primary guard, but it can be unset; orchestrator_comments is the source of
  // truth for what we authored (so preview/reply comments don't pollute context).
  const threadIds = opts.thread.map(c => c.id).filter(Boolean);
  const ourIds = new Set(
    threadIds.length
      ? db.select().from(orchestratorComments)
          .where(inArray(orchestratorComments.commentId, threadIds)).all().map(r => r.commentId)
      : [],
  );
  const priorCommentRows = opts.thread
    .filter(c => c.authorId !== integration.botUserId && c.id !== opts.triggeringCommentId && !ourIds.has(c.id))
    .map(c => ({ authorId: c.authorId, plainText: c.plainText }))
    .filter(c => c.plainText.trim().length > 0);
  // Resolve author display names (cached) so the thread reads as a real conversation.
  const priorComments = await Promise.all(priorCommentRows.map(async c => ({
    authorId: c.authorId,
    authorName: await userDisplayName(apiKey, c.authorId),
    plainText: c.plainText,
  })));
  const availableAgents = db.select().from(agents).all()
    .filter(a => a.id !== agentRef.agentId)
    .map(a => a.name);

  // Where the conversation lives (free pages) — title, link, and whether this
  // agent has been here before (so we can offer the full page on first contact).
  const pageRef: PageRef | undefined = anchor.kind === 'page'
    ? {
        title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']),
        url: typeof (anchor.page as Record<string, unknown>)['url'] === 'string'
          ? (anchor.page as Record<string, unknown>)['url'] as string
          : null,
        firstVisit: !hasPriorRunOnPage(agentRef.agentId, anchor.pageId),
      }
    : undefined;

  // Adapter without a dispatch impl yet (e.g. openclaw): show the exact prompt +
  // contract that WOULD be sent, using a placeholder token (no live run minted).
  if (!dispatchSupported(adapterType)) {
    const { system, prompt } = buildPrompt({
      ctx, anchor, priorComments, request: opts.request, availableAgents,
      commentedText: opts.commentedText, pageRef,
      runBlock: runBlock('(preview)', 'EXAMPLE_RUN_TOKEN', anchor.pageId, opts.discussionId),
    });
    emitLog(`prompt preview for "${agentRef.name}" (${adapterType}, ${system.length + prompt.length} chars) — dispatch not wired`);
    emitLog(`prompt preview content >>> ${JSON.stringify({ system, prompt })}`);
    const preview =
      `🔍 **NORC prompt preview — @${agentRef.name}**\n` +
      `Dispatch for this adapter (${adapterType}) isn't wired yet, so nothing was sent. ` +
      `Below is exactly what NORC would have sent (context level: ${ctx.contextLevel}):\n\n` +
      `——— SYSTEM ———\n${system}\n\n——— PROMPT ———\n${prompt}`;
    // Preview is always a comment (never page content) — on the precise text when
    // we have a discussion, otherwise page-level.
    if (opts.discussionId) {
      await safeWrite('prompt preview reply', () => postAgentReply(apiKey, opts.discussionId!, preview));
    } else {
      await safeWrite('prompt preview comment', () => postAgentComment(apiKey, anchor.pageId, preview));
    }
    if (opts.manageTaskStatus) await safeWrite('task revert', () => setTaskStatus(apiKey, anchor.pageId, 'Backlog'));
    return;
  }

  // Mint a run so the agent can report back via the Agent API, and inject the contract.
  const { id: runId, token } = createRun({
    agentId: agentRef.agentId,
    pageId: anchor.pageId,
    taskPageId: anchor.kind === 'task' ? anchor.pageId : null,
    anchorKind: anchor.kind,
    triggeringUserId: opts.triggeringUserId,
    manageTaskStatus: opts.manageTaskStatus,
  });
  const { system, prompt } = buildPrompt({
    ctx, anchor, priorComments, request: opts.request, availableAgents,
    commentedText: opts.commentedText, pageRef,
    runBlock: runBlock(runId, token, anchor.pageId, opts.discussionId),
  });

  // Write-FIRST: mark the agent Busy (and the task In Progress) before dispatch.
  await safeWrite('agent busy', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Busy'));
  await safeWrite('last active', () => touchLastActive(apiKey, agentRef.orgDbPageId));
  if (opts.manageTaskStatus) {
    await safeWrite('task in-progress', () => setTaskStatus(apiKey, anchor.pageId, 'In Progress'));
    // Reflect the assignment natively so the task shows who's on it.
    await safeWrite('task assignee', () => setTaskAssignee(apiKey, anchor.pageId, [agentRef.orgDbPageId]));
  }

  emitLog(`dispatching to "${agentRef.name}" (${adapterType}, level=${ctx.contextLevel}, via ${opts.how}, run ${runId}) on ${anchor.kind} page ${anchor.pageId}`);
  const result = await dispatch({ adapterType, config, system, prompt, agentName: agentRef.name, sessionId: anchor.pageId });

  if (!result.ok) {
    const failMsg = `**@${agentRef.name}** failed ✗ — ${result.error}`;
    if (opts.discussionId) await safeWrite('reply on text', () => postAgentReply(apiKey, opts.discussionId!, failMsg));
    else await postAgentComment(apiKey, anchor.pageId, failMsg);
    if (opts.manageTaskStatus) await safeWrite('task failed', () => setTaskStatus(apiKey, anchor.pageId, 'Failed'));
    await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
    finalizeRun(runId, 'failed');
    emitLog(`dispatch failed for "${agentRef.name}": ${result.error}`);
    return;
  }

  // Async adapter (openclaw WS): dispatched, but the reply arrives later via the
  // Agent API. Leave the run in-flight (Status already In Progress, agent Busy);
  // the agent's /complete — or the timeout sweep — finalizes it.
  if (result.async) {
    emitLog(`dispatched to "${agentRef.name}" (async) — awaiting Agent API callback on ${anchor.kind} page ${anchor.pageId} (run ${runId})`);
    return;
  }

  // If the agent already wrote via the Agent API during the run, respect that and
  // don't also post its text return. Finalize for it if it didn't call /complete.
  if (getRun(runId)?.agentActed) {
    if (getRun(runId)?.status === 'in_flight') {
      if (opts.manageTaskStatus) await safeWrite('task done', () => setTaskStatus(apiKey, anchor.pageId, 'Done'));
      await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
      finalizeRun(runId, 'done');
    }
    emitLog(`"${agentRef.name}" completed via Agent API on ${anchor.kind} page ${anchor.pageId}`);
    return;
  }

  // Simple path: the agent returned text → NORC posts it as the reply.
  const text = (result.text ?? '').trim() || '(the agent returned an empty reply)';
  if (anchor.kind === 'task') {
    // Task work: reply in the thread, drive Status, and record Agent Output.
    await postAgentComment(apiKey, anchor.pageId, `**@${agentRef.name}**\n\n${text}`);

    // Did the agent actually do it, or is it blocked/refusing? If blocked, hand off
    // to someone who can help (or ask a human) instead of marking it Done.
    if (opts.manageTaskStatus && await handleBlockedReply(integration, anchor, agentRef, runId, text)) return;

    if (opts.manageTaskStatus) {
      await safeWrite('task done', () => setTaskStatus(apiKey, anchor.pageId, 'Done'));
      await safeWrite('agent output', () => setTaskFields(apiKey, anchor.pageId, { agentOutput: text }));
    }
    await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
    finalizeRun(runId, 'done');
    emitLog(`"${agentRef.name}" completed on ${anchor.kind} page ${anchor.pageId}`);
    return;
  }

  // Free page: write content into the page or reply on the precise text.
  await deliverPageReply(apiKey, anchor, opts, agentRef.name, text);
  await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
  finalizeRun(runId, 'done');
  emitLog(`"${agentRef.name}" completed on ${anchor.kind} page ${anchor.pageId}`);
}

/**
 * After an agent replies on a task, ask the Triage LLM whether it actually
 * completed the work or is blocked/refusing. If blocked: free the agent, revert
 * the task to Backlog, finalize this attempt, and re-triage excluding this agent
 * (carrying what it said it needs) so a capable peer takes it — or the human is
 * asked. Returns true when it took over (caller must stop). No-op when triage is
 * off (returns false → caller marks Done as before).
 */
async function handleBlockedReply(integration: Integration, anchor: Anchor, agentRef: AgentRef, runId: string, reply: string): Promise<boolean> {
  const settings = getNorcSettings();
  if (!triageConfigured(settings)) return false;
  const apiKey = integration.apiKey;

  let assessment;
  try {
    assessment = await assessOutcome({
      provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
      apiKey: settings!.orchestratorApiKey ?? '', baseUrl: settings!.orchestratorBaseUrl, model: settings!.orchestratorModel,
      task: getAnyTitle((anchor.page as Record<string, unknown>)['properties']),
      agentName: agentRef.name, reply, candidates: rosterCandidates([agentRef.name]),
    });
  } catch (err) {
    emitLog(`outcome assessment failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return false;
  }
  if (assessment.outcome !== 'blocked') return false;

  const need = assessment.need?.trim();
  emitLog(`"${agentRef.name}" is blocked${need ? ` (needs: ${need})` : ''} — re-routing`);
  // The attempt is over: free the agent, revert the task, close this run.
  await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
  await safeWrite('task backlog', () => setTaskStatus(apiKey, anchor.pageId, 'Backlog'));
  finalizeRun(runId, 'done');

  const prefix = `⚠️ **@${agentRef.name}** couldn't complete this${need ? ` — needs: ${need}` : ''}. Finding someone who can.`;
  const thread = await listThreadComments(apiKey, anchor.pageId).catch(() => [] as ThreadComment[]);
  await runTriage(integration, anchor, { text: need ?? '', thread }, [agentRef.name], prefix);
  return true;
}
