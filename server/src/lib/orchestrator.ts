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
import { agents, notionIntegration, orchestratorComments, processedTriggers } from '../db/schema.js';
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
import { resolveAnchor, listThreadComments, collectBlockMentionPageIds, readBlockText, type Anchor, type ThreadComment } from './notion-anchor.js';
import { getAnyTitle } from './notion-props.js';
import { assembleContext, buildPrompt, type PageRef } from './context-assembler.js';
import { dispatch, dispatchSupported } from '../adapters/index.js';
import { createRun, getRun, finalizeRun, hasPriorRunOnPage } from './runs.js';
import { getNorcSettings } from './norc-settings.js';
import { triage } from './orchestrator-agent.js';
import {
  postComment, postCommentReply, appendBlocks,
  setTaskStatus, setTaskFields, setAgentStatus, touchLastActive,
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

/** Post a page-level NORC comment and record its id so we don't re-trigger on it. */
async function postAgentComment(apiKey: string, pageId: string, text: string): Promise<void> {
  recordOurComment((await postComment(apiKey, pageId, text)).commentId);
}

/** Reply on the precise text (into a discussion) and record the comment id. */
async function postAgentReply(apiKey: string, discussionId: string, text: string): Promise<void> {
  recordOurComment((await postCommentReply(apiKey, discussionId, text)).commentId);
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

  try {
    if (event.type === 'comment.created') {
      await handleCommentEvent(integration, event);
    } else if (event.type && PAGE_EVENT_TYPES.has(event.type)) {
      await handlePageEvent(integration, event);
    } else {
      emitLog(`webhook ignored: "${type}" is not a trigger event type`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    emitLog(`orchestrator error handling ${type}: ${msg}`);
  }
}

/** comment.created — a conversational turn; mentions live in the comment text. */
async function handleCommentEvent(integration: Integration, event: NotionWebhookEvent): Promise<void> {
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
      manageTaskStatus: false, how: 'comment mention',
    });
  }
}

/** page.* — mentions in property values / block content. On a Task = work. */
async function handlePageEvent(integration: Integration, event: NotionWebhookEvent): Promise<void> {
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
    const handled = await triageUnhandled(integration, anchor, { text: '', thread, dedupId: pageId });
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
      thread, request, manageTaskStatus: anchor.kind === 'task', how: anchor.kind === 'task' ? 'assignment' : 'page mention',
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
}

/**
 * The NORC Orchestrator (co-CEO): when no agent was matched, decide whether to
 * auto-route to the best agent (high confidence) or suggest one to the human.
 * Returns true when it took ownership of the event (so the caller skips the
 * generic "discarded" log). No-op (returns false) when disabled / no agents.
 */
async function triageUnhandled(integration: Integration, anchor: Anchor, opts: TriageOpts): Promise<boolean> {
  const settings = getNorcSettings();
  if (!settings?.orchestratorEnabled || !settings.orchestratorApiKey) return false;

  const dedupKey = `triage:${opts.dedupId}`;
  if (alreadyProcessed(dedupKey)) return true; // already triaged — don't re-fire or re-log
  markProcessed(dedupKey);

  const apiKey = integration.apiKey;
  const agentRows = db.select().from(agents).all();
  if (agentRows.length === 0) { emitLog('triage skipped: no agents registered'); return false; }

  const candidates = agentRows.map(a => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(a.metadata); } catch { /* */ }
    return {
      name: a.name,
      specialty: typeof meta['specialty'] === 'string' ? meta['specialty'] : (typeof meta['role'] === 'string' ? meta['role'] : ''),
      capabilities: typeof meta['capabilities'] === 'string' ? meta['capabilities'] : '',
    };
  });
  const title = getAnyTitle((anchor.page as Record<string, unknown>)['properties']);
  const conversation = opts.thread
    .filter(c => c.authorId !== integration.botUserId)
    .map(c => c.plainText)
    .filter(t => t.trim().length > 0);

  emitLog(`triage: NORC Orchestrator analyzing unassigned ${anchor.kind} ${anchor.pageId}`);
  let decision;
  try {
    decision = await triage({
      apiKey: settings.orchestratorApiKey,
      model: settings.orchestratorModel,
      systemPrompt: settings.orchestratorSystemPrompt ?? undefined,
      kind: anchor.kind, title, text: opts.text,
      commentedText: opts.commentedText, conversation, candidates,
    });
  } catch (err) {
    emitLog(`triage error: ${err instanceof Error ? err.message : 'unknown'}`);
    return false;
  }

  if (decision.decision === 'ignore') {
    emitLog(`triage: no routing (${decision.message || 'ignored'})`);
    return true;
  }

  const routed = decision.agent ? matchAgentByName(decision.agent) : null;
  if (decision.decision === 'route' && routed && decision.confidence >= settings.autoRouteThreshold) {
    emitLog(`triage: auto-routing to "${routed.name}" (confidence ${decision.confidence.toFixed(2)})`);
    await runAgentTurn(integration, anchor, routed, {
      thread: opts.thread,
      request: opts.text || 'The NORC Orchestrator routed this to you. Handle it using the context above.',
      discussionId: opts.discussionId, commentedText: opts.commentedText,
      manageTaskStatus: anchor.kind === 'task', how: 'orchestrator auto-route',
    });
    return true;
  }

  // Suggest (or route below threshold): tell the human who could take it.
  const body = decision.message?.trim()
    || (decision.agent ? `I think **@${decision.agent}** could handle this.` : 'No registered agent seems suited to this yet.');
  const text = `🧭 **NORC Orchestrator**\n${body}`;
  if (opts.discussionId) await safeWrite('triage reply', () => postAgentReply(apiKey, opts.discussionId!, text));
  else await safeWrite('triage comment', () => postAgentComment(apiKey, anchor.pageId, text));
  emitLog(`triage: suggested ${decision.agent ?? 'none'} (confidence ${decision.confidence.toFixed(2)})`);
  return true;
}

interface TurnOpts {
  thread: ThreadComment[];
  request: string;
  triggeringCommentId?: string;
  /** Discussion to reply into (so the comment lands on the precise text). */
  discussionId?: string | null;
  /** Text the triggering comment is anchored to (inline comments). */
  commentedText?: string;
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
  const priorComments = opts.thread
    .filter(c => c.authorId !== integration.botUserId && c.id !== opts.triggeringCommentId && !ourIds.has(c.id))
    .map(c => ({ authorId: c.authorId, plainText: c.plainText }))
    .filter(c => c.plainText.trim().length > 0);
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
  if (opts.manageTaskStatus) await safeWrite('task in-progress', () => setTaskStatus(apiKey, anchor.pageId, 'In Progress'));

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
  } else {
    // Free page: write content into the page or reply on the precise text.
    await deliverPageReply(apiKey, anchor, opts, agentRef.name, text);
  }
  if (opts.manageTaskStatus) {
    await safeWrite('task done', () => setTaskStatus(apiKey, anchor.pageId, 'Done'));
    await safeWrite('agent output', () => setTaskFields(apiKey, anchor.pageId, { agentOutput: text }));
  }
  await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
  finalizeRun(runId, 'done');
  emitLog(`"${agentRef.name}" completed on ${anchor.kind} page ${anchor.pageId}`);
}
