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
import { getAnyTitle, getRelationIds, getDate, getSelect } from './notion-props.js';
import { isInertTaskStatus } from './notion-provision.js';
import { assembleContext, buildPrompt, type PageRef } from './context-assembler.js';
import { dispatch, dispatchSupported } from '../adapters/index.js';
import { createRun, getRun, finalizeRun, hasPriorRunOnPage, timedOutAgentIdsForPage, activeRunCount, hasRunConflict, type TaskRun } from './runs.js';
import { enqueueTurn, nextEligible, claimAndCheck, dropItem, dropPendingForAgentPage, agentsWithPending, pendingCount, type QueuedTurn, type DispatchQueueRow } from './dispatch-queue.js';
import { unmetDependencies, detectDependencyCycle, getDependsOnIds } from './task-deps.js';
import { notionQuery } from './notion-client.js';
import { getNorcSettings } from './norc-settings.js';
import { triage, assessOutcome, classifyTaskWorthy, type TriageCandidate, type TaskWorthy } from './orchestrator-agent.js';
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

/** Best-effort: the Notion page a webhook event is about (undefined if unknown). */
function triggeringPageId(event: NotionWebhookEvent): string | undefined {
  return event.data?.page_id
    ?? (event.data?.parent?.type === 'page' ? event.data.parent.id : undefined)
    ?? (event.type && PAGE_EVENT_TYPES.has(event.type) ? event.entity?.id : undefined);
}

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

/** Release an idempotency key — used when queued work is dropped (task went
 * inert / deps unmet) so the same trigger can legitimately fire again later. */
function unmarkProcessed(key: string): void {
  db.delete(processedTriggers).where(eq(processedTriggers.triggerKey, key)).run();
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
    emitLog(`"${agentName}" wrote ${blocks.length} block(s) into ${anchor.kind} page ${anchor.pageId}`, agentName);
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

  // The Notion page this webhook is about — for page events the entity IS the
  // page; comment events carry it in data.page_id (or a page-type parent).
  // Attached to log lines so the UI can link straight to the page.
  const triggerPageId = triggeringPageId(event);

  emitLog(`webhook received: type=${type} entity=${entityId}`, 'Notion', triggerPageId);
  const rawJson = safeJson(raw);
  if (rawJson) emitLog(`webhook payload: ${rawJson}`, 'Notion', triggerPageId);

  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') {
    emitLog('webhook ignored: Notion integration not active', 'Notion', triggerPageId);
    return;
  }

  // Loop guard — ignore anything authored by our own integration bot.
  const authorIds = (event.authors ?? [])
    .map(a => a?.id)
    .filter((id): id is string => typeof id === 'string');
  if (integration.botUserId && authorIds.includes(integration.botUserId)) {
    emitLog('webhook ignored: authored by NORC bot (loop guard)', 'Notion', triggerPageId);
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
      emitLog(`webhook ignored: "${type}" is not a trigger event type`, 'Notion', triggerPageId);
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
    emitLog('webhook ignored: comment event carries no comment id', 'Notion');
    return;
  }
  if (db.select().from(orchestratorComments).where(eq(orchestratorComments.commentId, commentId)).all()[0]) {
    emitLog(`webhook ignored: comment ${commentId} was authored by NORC (loop guard)`, 'Notion', triggeringPageId(event));
    return;
  }
  const triggerKey = `comment:${commentId}`;
  if (alreadyProcessed(triggerKey)) {
    emitLog(`webhook ignored: comment ${commentId} already processed`, 'Notion', triggeringPageId(event));
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
    emitLog(`webhook ignored: comment ${commentId} has no resolvable page/parent`, 'Notion');
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
    if (!handled) emitLog(`webhook discarded: no agent mentioned in comment on page ${pageId}`, 'Notion', pageId);
    return;
  }

  const anchor = await resolveAnchor(apiKey, pageId);
  markProcessed(triggerKey);
  const onText = parent?.type === 'block' ? ' (on text)' : '';
  emitLog(`mention detected in comment on ${anchor.kind} page ${pageId}${onText}: ${matched.map(a => a.name).join(', ')}`, 'NORC', pageId);

  // For an inline comment, fetch the text it's anchored to so the agent knows
  // exactly what the human is reacting to.
  const commentedText = parent?.type === 'block' ? await readBlockText(apiKey, threadBlockId) : '';

  const request = (triggering?.plainText ?? '').trim() || 'Please respond.';

  // Chat or work? Real WORK on a non-task surface becomes a tracked task that
  // goes through the capacity gate (queued when the agent is busy); pure chat
  // dispatches immediately on the parallel chat lane. On a task page the task
  // already exists — comments there are iteration, so always chat.
  if (anchor.kind !== 'task') {
    const cls = await classifyWorkRequest(anchor, request);
    if (cls.task) {
      const created = await createTaskFromWork(integration, anchor, request, cls,
        triggering?.discussionId ?? null, triggering?.authorId ?? triggeringUserId, matched);
      if (created) return; // the task (and its assignment/triage) carries the work — no double reply
    }
  }

  for (const agent of matched) {
    // A chat turn — reply in parallel on an isolated session; don't drive task
    // Status and don't consume work capacity.
    await requestAgentTurn(integration, anchor, agent, {
      thread, request, triggeringCommentId: commentId,
      discussionId: triggering?.discussionId ?? null, commentedText,
      triggeringUserId: triggering?.authorId ?? triggeringUserId,
      threadBlockId, lane: 'chat',
      manageTaskStatus: false, how: 'comment mention',
    });
  }
}

/** Classify a comment request as trackable WORK vs chat. Uses the Triage LLM
 * when configured (safe default on error: chat — never block a conversation);
 * falls back to the wantsContent heuristic otherwise. */
async function classifyWorkRequest(anchor: Anchor, request: string): Promise<TaskWorthy> {
  if (!request.trim()) return { task: false };
  const settings = getNorcSettings();
  if (triageConfigured(settings)) {
    try {
      return await classifyTaskWorthy({
        provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
        apiKey: settings!.orchestratorApiKey ?? '', baseUrl: settings!.orchestratorBaseUrl, model: settings!.orchestratorModel,
        kind: anchor.kind, title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']), text: request,
      });
    } catch (err) {
      emitLog(`work classification failed (treating as chat): ${err instanceof Error ? err.message : 'unknown'}`, 'Triage');
      return { task: false };
    }
  }
  return wantsContent(request) ? { task: true, title: request.slice(0, 80) } : { task: false };
}

/**
 * A comment on a non-task page asked for real WORK: create a tracked task,
 * note it on the thread with a real @link, then hand it to the capacity gate —
 * directly to the @mentioned agents when the human named them (queued if
 * they're busy), otherwise via triage (assign + @mention). Returns false when
 * no task could be created (caller falls back to a chat reply so the mention
 * isn't dropped).
 */
async function createTaskFromWork(
  integration: Integration, anchor: Anchor, request: string, cls: TaskWorthy,
  discussionId: string | null, triggeringUserId: string | null, assignees: AgentRef[],
): Promise<boolean> {
  if (anchor.kind === 'task' || !cls.task || !request.trim()) return false;
  const apiKey = integration.apiKey;
  const title = cls.title?.trim() || request.slice(0, 80);
  const kpis = cls.kpis?.trim() || undefined;

  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) { emitLog('task-from-work skipped: no tasks DB provisioned', 'Triage'); return false; }
  const projectId = anchor.kind === 'project' ? anchor.pageId : null;
  const assigneeIds = assignees.map(a => a.orgDbPageId).filter(Boolean);

  let pageId = '';
  try {
    ({ pageId } = await createTaskPage(apiKey, tasksDb.notionDatabaseId, { title, kpis: kpis ?? '', projectId, assigneeIds }));
  } catch (err) { emitLog(`task-from-work: create failed: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage'); return false; }
  await safeWrite('task body', () => appendBlocks(apiKey, pageId, markdownToBlocks(request)));
  markProcessed(`triage:${pageId}`); // a creation webhook must not re-triage it
  emitLog(`task-from-work: created "${title}" (${pageId}) from ${anchor.kind} ${anchor.pageId}`, 'Triage');

  // Tell the thread, with a real @link to the new task.
  await postAgentRich(apiKey, anchor.pageId, discussionId, [
    `🧭 **NORC Triage Agent**\nI turned this into a task: `, { pageId },
    assignees.length ? ` — handing it to ${assignees.map(a => `@${a.name}`).join(', ')} now.` : ` — routing it now.`,
  ]);

  try {
    const taskAnchor = await resolveAnchor(apiKey, pageId);
    if (assignees.length > 0) {
      // The human named who should do it — dispatch (or queue) for them directly.
      for (const agent of assignees) {
        markProcessed(`page:${pageId}:${agent.agentId}`); // the assignment is handled here
        await requestAgentTurn(integration, taskAnchor, agent, {
          thread: [], request, triggeringUserId,
          manageTaskStatus: true, how: 'task from comment',
        });
      }
    } else {
      // Nobody named — let triage assign/route it (sets Assigned To + real @mention).
      await runTriage(integration, taskAnchor, { text: request, thread: [], triggeringUserId }, [], '');
    }
  } catch (err) { emitLog(`task-from-work: routing failed: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage'); }
  return true;
}

/** page.* — mentions in property values / block content. On a Task = work. */
async function handlePageEvent(integration: Integration, event: NotionWebhookEvent, triggeringUserId: string | null): Promise<void> {
  const apiKey = integration.apiKey;
  const pageId = event.entity?.id;
  if (!pageId) {
    emitLog('webhook ignored: page event carries no page id', 'Notion');
    return;
  }

  const anchor = await resolveAnchor(apiKey, pageId);
  const properties = (anchor.page as Record<string, unknown>)['properties'];

  // A task with an inert Status (empty / Draft / Proposed) is still being written
  // or validated by a human — don't dispatch or triage it, even if an agent is
  // already in "Assigned To". Return BEFORE any markProcessed so no idempotency
  // key is consumed: setting the Status to Backlog fires a properties_updated
  // event and the task dispatches normally then.
  if (anchor.kind === 'task') {
    const status = getSelect(properties, 'Status') ?? '';
    if (isInertTaskStatus(status)) {
      emitLog(`webhook ignored: task ${pageId} Status is ${status || 'empty'} — set it to Backlog to hand it to NORC`, 'Notion', pageId);
      return;
    }
    // A task flipped to Done (e.g. by a human, manually) may unblock dependents.
    // NORC's own Done writes never reach here — they're bot-authored, so the
    // loop guard already dropped them.
    if (status === 'Done') {
      void releaseDependents(integration, pageId).catch(err =>
        emitLog(`dependency release failed for ${pageId}: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage', pageId));
      return;
    }
  }

  // A task with a "Scheduled For" date is owned by the SCHEDULER, not the
  // create/assign webhook — otherwise it would run the moment it's assigned,
  // ignoring the schedule. Defer here so the scheduler runs it at the due time.
  if (anchor.kind === 'task') {
    const sched = getDate(properties, 'Scheduled For');
    const ms = sched ? Date.parse(sched) : NaN;
    if (!Number.isNaN(ms)) {
      const schedulerOn = !!getNorcSettings()?.schedulerEnabled;
      const future = ms > Date.now();
      if (schedulerOn) {
        // Single owner: the scheduler runs it (past-due is picked up within a poll).
        emitLog(`task ${pageId} is scheduled for ${new Date(ms).toISOString()} — deferring to the scheduler`, 'Schedule', pageId);
        return;
      }
      if (future) {
        // Can't honor a future schedule without the scheduler — defer + tell the human once.
        emitLog(`task ${pageId} is scheduled for ${new Date(ms).toISOString()} but the scheduler is OFF — deferring`, 'Schedule', pageId);
        const warnKey = `sched-off-warn:${pageId}`;
        if (!alreadyProcessed(warnKey)) {
          markProcessed(warnKey);
          await safeWrite('scheduler-off note', () => postAgentComment(apiKey, pageId,
            `🧭 **NORC**\n⏰ This task is scheduled for ${new Date(ms).toISOString()}, but the task scheduler is turned off, so I won't run it at that time. Enable it in **Settings → Scheduling & Automation** (or clear "Scheduled For" to run it now).`));
        }
        return;
      }
      // Past date + scheduler off → nothing will pick it up later; run now.
      emitLog(`task ${pageId} has a past Scheduled For and the scheduler is off — running now`, 'Schedule', pageId);
    }
  }

  // Dependency gate: a task whose "Depends On" chain isn't all Done is HELD —
  // no dedup key is consumed, so it dispatches normally once released (by
  // releaseDependents when the last dep completes, or by any later edit).
  if (anchor.kind === 'task') {
    const unmet = await unmetDependencies(apiKey, properties);
    if (unmet.length > 0) {
      await holdForDependencies(integration, anchor, unmet);
      return;
    }
  }

  const candidateIds = [
    ...extractRelationPageIds(properties),
    ...extractPropertyMentionPageIds(properties),
    ...await collectBlockMentionPageIds(apiKey, pageId),
  ];

  const matched = matchAgents(candidateIds);
  if (matched.length === 0) {
    const thread = await listThreadComments(apiKey, pageId);
    const handled = await triageUnhandled(integration, anchor, { text: '', thread, dedupId: pageId, triggeringUserId });
    if (!handled) emitLog(`webhook discarded: no agent referenced on ${anchor.kind} page ${pageId}`, 'NORC', pageId);
    return;
  }

  // Per-(page, agent) idempotency so repeated edits don't re-fire.
  const fresh = matched.filter(a => !alreadyProcessed(`page:${pageId}:${a.agentId}`));
  if (fresh.length === 0) {
    emitLog(`webhook ignored: ${anchor.kind} page ${pageId} already handled for ${matched.map(a => a.name).join(', ')}`, 'NORC', pageId);
    return;
  }

  const thread = await listThreadComments(apiKey, pageId);
  emitLog(`mention detected on ${anchor.kind} page ${pageId}: ${fresh.map(a => a.name).join(', ')}`, 'NORC', pageId);
  for (const agent of fresh) {
    markProcessed(`page:${pageId}:${agent.agentId}`);
    const request = anchor.kind === 'task'
      ? 'You have been assigned to this task. Complete it using the context above and report your result.'
      : `You were referenced on this ${anchor.kind}. Respond using the context above.`;
    await requestAgentTurn(integration, anchor, agent, {
      thread, request, triggeringUserId,
      manageTaskStatus: anchor.kind === 'task', how: anchor.kind === 'task' ? 'assignment' : 'page mention',
    });
  }
}

/** Log + (once per task) explain in Notion why a dependency-blocked task is held. */
async function holdForDependencies(integration: Integration, anchor: Anchor, unmet: { id: string; title: string; status: string }[]): Promise<void> {
  const apiKey = integration.apiKey;
  const list = unmet.map(d => `"${d.title}" (${d.status})`).join(', ');
  emitLog(`task ${anchor.pageId} held: waiting on ${unmet.length} dependenc${unmet.length === 1 ? 'y' : 'ies'} — ${list}`, 'NORC', anchor.pageId);
  // The comment is one-time (the dedup key gates ONLY the comment, never processing).
  const noteKey = `dep-hold:${anchor.pageId}`;
  if (alreadyProcessed(noteKey)) return;
  markProcessed(noteKey);
  const cycle = await detectDependencyCycle(apiKey, anchor.pageId, (anchor.page as Record<string, unknown>)['properties'])
    .catch(() => false);
  const cycleNote = cycle
    ? `\n⚠️ These dependencies form a CIRCLE — none of them can ever finish. Please break the cycle by removing one "Depends On" link.`
    : '';
  const failedNote = unmet.some(d => d.status === 'Failed')
    ? `\n⚠️ A dependency has FAILED — I'll keep holding this until a human fixes or re-runs it.`
    : '';
  await safeWrite('dep-hold note', () => postAgentComment(apiKey, anchor.pageId,
    `🧭 **NORC**\n⏳ This task waits on: ${list}. I'll start it automatically when ${unmet.length === 1 ? 'it completes' : 'they all complete'}.${failedNote}${cycleNote}`));
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

/** The agent roster (name/specialty/capabilities/technology + current load) for
 * triage/assessment, excluding the given names. Mirrors the Org DB metadata the
 * agents registered with; load lets triage route around saturated agents. */
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
      activeRuns: activeRunCount(a.id),
      queuedCount: pendingCount(a.id),
      maxConcurrentRuns: a.maxConcurrentRuns,
    };
  });
}

async function triageUnhandled(integration: Integration, anchor: Anchor, opts: TriageOpts): Promise<boolean> {
  if (!triageConfigured(getNorcSettings())) return false;

  // An inert task (empty / Draft / Proposed Status) is parked by a human — the
  // co-CEO must not auto-route it. Deliberate hold, so take ownership (true);
  // no dedup key is consumed, so it triages normally once the Status changes.
  if (anchor.kind === 'task') {
    const status = getSelect((anchor.page as Record<string, unknown>)['properties'], 'Status') ?? '';
    if (isInertTaskStatus(status)) {
      emitLog(`triage skipped: task ${anchor.pageId} Status is ${status || 'empty'} — parked until a human sets it to Backlog`, 'Triage');
      return true;
    }
    // Same deliberate hold for unmet dependencies — releaseDependents will
    // route it when the chain completes (no dedup key consumed here).
    const unmet = await unmetDependencies(integration.apiKey, (anchor.page as Record<string, unknown>)['properties']);
    if (unmet.length > 0) {
      emitLog(`triage skipped: task ${anchor.pageId} waits on ${unmet.length} dependenc${unmet.length === 1 ? 'y' : 'ies'}`, 'Triage', anchor.pageId);
      return true;
    }
  }

  const dedupKey = `triage:${opts.dedupId}`;
  if (alreadyProcessed(dedupKey)) return true; // already triaged — don't re-fire or re-log
  markProcessed(dedupKey);

  if (db.select().from(agents).all().length === 0) { emitLog('triage skipped: no agents registered', 'Triage'); return false; }

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

  const candidates = rosterCandidates(excludeNames);
  if (candidates.length === 0) {
    await announce('No remaining agents to try — please assign someone manually, or tell me to investigate.', true);
    emitLog('triage: no remaining agents after exclusions', 'Triage');
    return 'no-agents';
  }
  const title = getAnyTitle((anchor.page as Record<string, unknown>)['properties']);
  const conversation = ctx.thread
    .filter(c => c.authorId !== integration.botUserId)
    .map(c => c.plainText)
    .filter(t => t.trim().length > 0);

  emitLog(`triage: NORC Triage Agent analyzing unassigned ${anchor.kind} ${anchor.pageId}${excludeNames.length ? ` (excluding: ${excludeNames.join(', ')})` : ''}`, 'Triage');
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
    emitLog(`triage error: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage');
    await announce('I hit an error deciding who should take this — please assign someone manually.');
    return 'error';
  }

  if (decision.decision === 'ignore') {
    const msg = decision.message?.trim() || 'No one is assigned and no registered agent clearly fits this. Who should take it?';
    await announce(msg, true);
    emitLog(`triage: no clear owner (${decision.message || 'asked'})`, 'Triage');
    return 'asked';
  }

  const routed = decision.agent ? matchAgentByName(decision.agent) : null;
  if (decision.decision === 'route' && routed && decision.confidence >= settings!.autoRouteThreshold) {
    emitLog(`triage: auto-routing to "${routed.name}" (confidence ${decision.confidence.toFixed(2)})`, 'Triage');
    const why = decision.message?.trim() || `No one was assigned, so I'm routing this.`;
    // Real @mention of the agent's Org DB page (clickable, not plain text).
    await postAgentRich(apiKey, anchor.pageId, ctx.discussionId, [
      `🧭 **NORC Triage Agent**\n${prefix}${why}\n\nRouting to `,
      { pageId: routed.orgDbPageId },
      ` now — reply here to redirect.`,
    ]);
    await requestAgentTurn(integration, anchor, routed, {
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
  emitLog(`triage: suggested ${decision.agent ?? 'none'} (confidence ${decision.confidence.toFixed(2)})`, 'Triage');
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

  emitLog(`run ${run.id} timed out — "${agentName}" didn't report back; escalating`, agentRow?.name ?? 'NORC');
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

/**
 * Park a task an agent couldn't finish for lack of human input: free the agent,
 * set the task to 'Blocked' (inert — NORC won't re-dispatch it), and @mention the
 * human with what's needed so they can unblock it. Closes this run (the attempt is
 * over); the human hands it back by mentioning an agent or moving Status to Backlog.
 */
async function parkTaskBlocked(args: {
  apiKey: string;
  anchor: Anchor;
  agentName: string;
  agentOrgDbPageId?: string | null;
  runId: string;
  manageTaskStatus: boolean;
  need: string;
  triggeringUserId?: string | null;
}): Promise<void> {
  const { apiKey, anchor, agentName, agentOrgDbPageId, runId, manageTaskStatus, need, triggeringUserId } = args;
  if (agentOrgDbPageId) await safeWrite('agent available', () => setAgentStatus(apiKey, agentOrgDbPageId, 'Available'));
  if (manageTaskStatus) await safeWrite('task blocked', () => setTaskStatus(apiKey, anchor.pageId, 'Blocked'));
  const who = triggeringUserId ?? pageCreatedById(anchor.page as Record<string, unknown>);
  const detail = need.trim() ? `\n\n_Needs:_ ${need.trim()}` : '';
  await safeWrite('blocked notice', () => postAgentComment(apiKey, anchor.pageId,
    `🚧 **@${agentName}** is blocked and needs your input before this can continue.${detail}`, who));
  finalizeRun(runId, 'done');
  emitLog(`"${agentName}" parked ${anchor.kind} ${anchor.pageId} as Blocked — pinged human`, agentName);
}

/**
 * The async (Agent API) completion path — an openclaw agent reported back via
 * POST /runs/:token/complete. Mirrors the sync completion in runAgentTurn: it
 * ALWAYS leaves a visible Notion comment, drives task status, and — parity with
 * the sync handleBlockedReply — catches give-up / blocked reports and parks the
 * task for a human instead of silently marking it Done.
 */
export async function finalizeAgentReport(run: TaskRun, report: { status?: string; summary?: string }): Promise<void> {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') return;
  const apiKey = integration.apiKey;

  const agentRow = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0];
  const agentName = agentRow?.name ?? 'NORC';
  const orgDbPageId = agentRow?.orgDbPageId ?? null;
  const manageTaskStatus = run.manageTaskStatus && !!run.taskPageId;
  const summary = typeof report.summary === 'string' ? report.summary.trim() : '';
  const reported: 'done' | 'failed' | 'blocked' =
    report.status === 'failed' ? 'failed' : report.status === 'blocked' ? 'blocked' : 'done';

  // Resolve the anchor so we can @mention the right human if we park it.
  let anchor: Anchor | null = null;
  try { anchor = await resolveAnchor(apiKey, run.pageId); } catch { /* park falls back below */ }

  // A "done" report can really be a give-up. When triage is configured, assess it
  // (parity with the sync path) and treat a blocked verdict as a block.
  let outcome: 'done' | 'failed' | 'blocked' = reported;
  let need = summary;
  if (reported === 'done' && manageTaskStatus && anchor) {
    const settings = getNorcSettings();
    if (triageConfigured(settings) && summary) {
      try {
        const assessment = await assessOutcome({
          provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
          apiKey: settings!.orchestratorApiKey ?? '', baseUrl: settings!.orchestratorBaseUrl, model: settings!.orchestratorModel,
          task: getAnyTitle((anchor.page as Record<string, unknown>)['properties']),
          agentName, reply: summary, candidates: rosterCandidates([agentName]),
        });
        if (assessment.outcome === 'blocked') { outcome = 'blocked'; need = assessment.need?.trim() || summary; }
      } catch (err) {
        emitLog(`outcome assessment failed: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage');
      }
    }
  }

  if (outcome === 'blocked' && anchor) {
    await parkTaskBlocked({
      apiKey, anchor, agentName, agentOrgDbPageId: orgDbPageId, runId: run.id,
      manageTaskStatus, need, triggeringUserId: run.triggeringUserId,
    });
    return;
  }

  // Done / failed: always leave a visible comment, then drive status + free agent.
  const ok = outcome === 'done';
  const body = summary
    ? `**@${agentName}**\n\n${summary}`
    : (ok ? `✅ **@${agentName}** completed this task.` : `⚠️ **@${agentName}** reported it couldn't complete this task.`);
  await safeWrite('completion comment', () => postAgentComment(apiKey, run.pageId, body));

  if (manageTaskStatus && run.taskPageId) {
    await safeWrite('task status', () => setTaskStatus(apiKey, run.taskPageId!, ok ? 'Done' : 'Failed'));
    if (summary) await safeWrite('agent output', () => setTaskFields(apiKey, run.taskPageId!, { agentOutput: summary }));
    if (ok) void releaseDependents(integration, run.taskPageId).catch(() => {});
  }
  if (orgDbPageId) await safeWrite('agent available', () => setAgentStatus(apiKey, orgDbPageId, 'Available'));
  finalizeRun(run.id, ok ? 'done' : 'failed');
  emitLog(`agent API: run ${run.id} completed (${ok ? 'done' : 'failed'})`, agentName);
}

/**
 * A task just completed — release any task that "Depends On" it and is now
 * fully unblocked. Hooked everywhere a task transitions to Done (NORC's sync
 * path, the Agent API /complete and /status routes, and manual human flips via
 * the Done webhook branch). Idempotent across hooks: one release attempt per
 * (dependent, completed-dep) pair.
 */
export async function releaseDependents(integration: Integration, completedTaskPageId: string): Promise<void> {
  const apiKey = integration.apiKey;
  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) return;

  // Every task pointing at the completed one via "Depends On".
  const dependents: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  try {
    do {
      const res = await notionQuery<Record<string, unknown>>(apiKey, tasksDb.notionDatabaseId, {
        filter: { property: 'Depends On', relation: { contains: completedTaskPageId } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      dependents.push(...(Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : []));
      cursor = res['has_more'] === true && typeof res['next_cursor'] === 'string' ? res['next_cursor'] as string : undefined;
    } while (cursor);
  } catch {
    // Most likely "Depends On" isn't provisioned in this workspace — nothing to release.
    return;
  }
  if (dependents.length === 0) return;
  emitLog(`task ${completedTaskPageId} is Done — checking ${dependents.length} dependent task(s)`, 'Triage', completedTaskPageId);

  for (const row of dependents) {
    const depTaskId = String(row['id'] ?? '');
    if (!depTaskId) continue;
    // One release attempt per (dependent, completed dep) pair — several hooks
    // can fire for a single completion (/status then /complete).
    const dedupKey = `dep-release:${depTaskId}:${completedTaskPageId}`;
    if (alreadyProcessed(dedupKey)) continue;
    markProcessed(dedupKey);

    const props = row['properties'];
    const status = getSelect(props, 'Status') ?? '';
    if (status !== 'Backlog') continue; // inert = parked by a human; Queued/In Progress/Done/Failed = not eligible
    const recurrence = getSelect(props, 'Recurrence') ?? 'None';
    if (recurrence && recurrence !== 'None') continue; // recurring templates belong to the scheduler

    // Scheduled tasks belong to the scheduler too (it has its own dep gate and
    // never consumed this occurrence while the task was held).
    const sched = getDate(props, 'Scheduled For');
    const schedMs = sched ? Date.parse(sched) : NaN;
    if (!Number.isNaN(schedMs) && (getNorcSettings()?.schedulerEnabled || schedMs > Date.now())) {
      emitLog(`dependent task ${depTaskId} is scheduled — leaving it to the scheduler`, 'Triage', depTaskId);
      continue;
    }

    // Release only when the WHOLE chain is met (it may have other open deps).
    const unmet = await unmetDependencies(apiKey, props);
    if (unmet.length > 0) {
      emitLog(`dependent task ${depTaskId} still waits on ${unmet.length} other dependenc${unmet.length === 1 ? 'y' : 'ies'}`, 'Triage', depTaskId);
      continue;
    }

    let anchor: Anchor;
    try { anchor = await resolveAnchor(apiKey, depTaskId); } catch { continue; }
    const assigned = matchAgents(getRelationIds(props, 'Assigned To'));
    emitLog(`dependencies met for task ${depTaskId} — releasing${assigned.length ? ` to ${assigned.map(a => a.name).join(', ')}` : ' via triage'}`, 'Triage', depTaskId);
    if (assigned.length > 0) {
      for (const agent of assigned) {
        markProcessed(`page:${depTaskId}:${agent.agentId}`); // handled here — later edits must not double-fire
        await requestAgentTurn(integration, anchor, agent, {
          thread: [],
          request: 'A task this one depends on is now complete, so this task is unblocked. Complete it using the context above and report your result.',
          manageTaskStatus: true, how: 'dependency release',
        });
      }
    } else {
      // runTriage directly (not triageUnhandled): propose-tasks pre-consumes
      // the `triage:<id>` key at creation, which would short-circuit the hold→release path.
      await runTriage(integration, anchor, { text: getAnyTitle(props), thread: [] }, [],
        'A dependency just completed — this task is now unblocked.');
    }
  }
}

export interface ProposedTask {
  title: string;
  description?: string;
  kpis?: string;
  /** Indices of EARLIER tasks in the same batch this one depends on (validated
   * by the route: always < this task's index, so the batch is a DAG). */
  dependsOn?: number[];
}

/**
 * An agent (e.g. a company-brain after a planning discussion) hands NORC a list of
 * follow-up tasks. For each: create a Backlog row in the Tasks DB (linked to the
 * proposing run's project when there is one), then triage it — auto-route when
 * confident, otherwise ask the human in Notion + email. Tasks with `dependsOn`
 * are created HELD (no triage) and auto-released by releaseDependents as their
 * predecessors complete. Posts one summary comment on the source page and
 * returns each task's id + disposition.
 */
export async function proposeTasks(opts: {
  sourcePageId: string;
  proposerName?: string;
  tasks: ProposedTask[];
}): Promise<{ created: { id: string; title: string; disposition: TriageOutcome | 'created' | 'held' }[] }> {
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

  const created: { id: string; title: string; disposition: TriageOutcome | 'created' | 'held' }[] = [];
  // Created page id per batch index — what later tasks' dependsOn resolves against.
  const createdIdByIndex: (string | null)[] = opts.tasks.map(() => null);
  for (let i = 0; i < opts.tasks.length; i++) {
    const t = opts.tasks[i]!;
    const title = t.title.trim();
    if (!title) continue;
    // dependsOn indices are always earlier in the batch, so their ids exist by
    // now; a predecessor that failed to create is simply skipped.
    const dependsOn = (t.dependsOn ?? [])
      .map(idx => createdIdByIndex[idx])
      .filter((id): id is string => !!id);
    let pageId = '';
    try {
      ({ pageId } = await createTaskPage(apiKey, tasksDb.notionDatabaseId, { title, kpis: t.kpis, projectId, dependsOn }));
    } catch (err) {
      emitLog(`propose-tasks: failed to create "${title}": ${err instanceof Error ? err.message : 'error'}`, 'Triage');
      continue;
    }
    createdIdByIndex[i] = pageId;
    // Put the description in the task body so the assigned agent sees it as content.
    if (t.description && t.description.trim()) {
      await safeWrite('task description', () => appendBlocks(apiKey, pageId, markdownToBlocks(t.description!.trim())));
    }
    // A creation webhook on this fresh page must not re-trigger triage.
    markProcessed(`triage:${pageId}`);

    let disposition: TriageOutcome | 'created' | 'held' = 'created';
    if (dependsOn.length > 0) {
      // Held: releaseDependents triages/dispatches it when its chain completes.
      disposition = 'held';
    } else if (triageConfigured(getNorcSettings())) {
      try {
        const anchor = await resolveAnchor(apiKey, pageId);
        disposition = await runTriage(integration, anchor, { text: t.description?.trim() || title, thread: [] }, [], '');
      } catch (err) {
        emitLog(`propose-tasks: triage failed for "${title}": ${err instanceof Error ? err.message : 'error'}`, 'Triage');
      }
    }
    created.push({ id: pageId, title, disposition });
    emitLog(`propose-tasks: created "${title}" (${pageId}) → ${disposition}`, 'Triage');
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
    emitLog(`scheduler: can't read task ${taskPageId}: ${err instanceof Error ? err.message : 'error'}`, 'Schedule');
    return;
  }
  const props = (anchor.page as Record<string, unknown>)['properties'];
  const matched = matchAgents(getRelationIds(props, 'Assigned To'));
  if (matched.length) {
    const request = 'This scheduled task is now due. Complete it using the context above and report your result.';
    for (const agent of matched) {
      await requestAgentTurn(integration, anchor, agent, { thread: [], request, manageTaskStatus: true, how });
    }
    return;
  }
  // No assignee → triage assigns/asks.
  await triageUnhandled(integration, anchor, { text: getAnyTitle(props), thread: [], dedupId: occurrenceKey });
}

function dispositionLabel(d: TriageOutcome | 'created' | 'held'): string {
  switch (d) {
    case 'routed': return 'created & routed to an agent';
    case 'suggested': return 'created — suggested an agent, awaiting your confirmation';
    case 'asked': return 'created — no clear owner, asked the team';
    case 'no-agents': return 'created — no agents available';
    case 'error': return 'created — triage error';
    case 'disabled': return 'created (triage off)';
    case 'held': return 'created — waits on an earlier task in this batch';
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
  /** Where the triggering comment's thread lives (a block id for inline
   * comments) — persisted with queued turns so the drain re-lists the right thread. */
  threadBlockId?: string;
  /** 'work' (default) is capacity-gated and queued; 'chat' dispatches
   * immediately, in parallel, on an isolated `#chat` session. */
  lane?: 'work' | 'chat';
  manageTaskStatus: boolean;
  how: string;
}

/** The Notion project a turn belongs to — the per-(agent, project) serialization key. */
function projectIdForAnchor(anchor: Anchor): string | null {
  if (anchor.kind === 'task') {
    return getRelationIds((anchor.page as Record<string, unknown>)['properties'], 'Project')[0] ?? null;
  }
  if (anchor.kind === 'project') return anchor.pageId;
  return null;
}

/** A run minted by the capacity gate in the same tick as its checks. */
interface Reservation {
  runId: string;
  token: string;
  firstVisit: boolean;
  lane: 'work' | 'chat';
}

/** Mint a run SYNCHRONOUSLY (no awaits) — the caller's capacity checks stay
 * valid because nothing else can interleave before the insert. firstVisit is
 * computed pre-mint so the fresh run doesn't shadow it. */
function mintReservation(anchor: Anchor, agentRef: AgentRef, opts: TurnOpts, projectId: string | null, lane: 'work' | 'chat'): Reservation {
  const firstVisit = !hasPriorRunOnPage(agentRef.agentId, anchor.pageId);
  const { id, token } = createRun({
    agentId: agentRef.agentId,
    pageId: anchor.pageId,
    taskPageId: anchor.kind === 'task' ? anchor.pageId : null,
    anchorKind: anchor.kind,
    title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']) || null,
    projectId,
    lane,
    triggeringUserId: opts.triggeringUserId,
    manageTaskStatus: opts.manageTaskStatus,
  });
  return { runId: id, token, firstVisit, lane };
}

/** Run a reserved turn; a throw must finalize the pre-minted run (otherwise it
 * sits in flight until the timeout sweep) and free the agent. */
async function runReserved(integration: Integration, anchor: Anchor, agentRef: AgentRef, opts: TurnOpts, reservation: Reservation): Promise<void> {
  try {
    await runAgentTurn(integration, anchor, agentRef, opts, reservation);
  } catch (err) {
    finalizeRun(reservation.runId, 'failed');
    await safeWrite('agent available', () => setAgentStatus(integration.apiKey, agentRef.orgDbPageId, 'Available'));
    emitLog(`turn error for "${agentRef.name}" on ${anchor.kind} page ${anchor.pageId}: ${err instanceof Error ? err.message : 'unknown'}`, agentRef.name, anchor.pageId);
  }
}

/**
 * The dispatch gate — the single entry point for agent turns. Enforces the
 * agent's maxConcurrentRuns cap and the HARD rule of one in-flight work run per
 * (agent, project) / (agent, page): work that doesn't fit is parked in the
 * dispatch queue and drained as runs finalize. Chat-lane turns bypass the gate
 * (parallel, isolated `#chat` session). The capacity checks and the run mint /
 * enqueue happen with NO awaits in between — that's what makes them race-free.
 */
export async function requestAgentTurn(integration: Integration, anchor: Anchor, agentRef: AgentRef, opts: TurnOpts): Promise<void> {
  const agentRow = db.select().from(agents).where(eq(agents.id, agentRef.agentId)).all()[0];
  if (!agentRow) {
    emitLog(`dispatch skipped: agent "${agentRef.name}" no longer registered`, agentRef.name);
    return;
  }
  // Preview adapters mint no run and consume no capacity.
  if (!dispatchSupported(agentRow.adapterType as AdapterType)) {
    await runAgentTurn(integration, anchor, agentRef, opts);
    return;
  }

  const projectId = projectIdForAnchor(anchor);

  if (opts.lane === 'chat') {
    const reservation = mintReservation(anchor, agentRef, opts, projectId, 'chat');
    await runReserved(integration, anchor, agentRef, opts, reservation);
    return;
  }

  // ── sync gate: check → (enqueue | mint) without yielding the event loop ──
  const atCapacity = activeRunCount(agentRef.agentId) >= agentRow.maxConcurrentRuns;
  const conflicted = hasRunConflict(agentRef.agentId, projectId, anchor.pageId);
  if (atCapacity || conflicted) {
    const payload: QueuedTurn = {
      request: opts.request,
      ...(opts.triggeringCommentId ? { triggeringCommentId: opts.triggeringCommentId } : {}),
      ...(opts.discussionId !== undefined ? { discussionId: opts.discussionId } : {}),
      ...(opts.commentedText ? { commentedText: opts.commentedText } : {}),
      ...(opts.triggeringUserId !== undefined ? { triggeringUserId: opts.triggeringUserId } : {}),
      ...(opts.threadBlockId ? { threadBlockId: opts.threadBlockId } : {}),
      manageTaskStatus: opts.manageTaskStatus,
      how: opts.how,
    };
    const { position } = enqueueTurn({
      agentId: agentRef.agentId,
      pageId: anchor.pageId,
      taskPageId: anchor.kind === 'task' ? anchor.pageId : null,
      projectId,
      anchorKind: anchor.kind,
      title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']) || null,
      payload,
    });
    const reason = conflicted ? 'an in-flight run on the same project/page' : `the cap of ${agentRow.maxConcurrentRuns}`;
    emitLog(`queued for "${agentRef.name}" (position ${position}, via ${opts.how}) on ${anchor.kind} page ${anchor.pageId} — blocked by ${reason}`, agentRef.name, anchor.pageId);
    // Make the wait visible: the task shows Queued, the thread gets a note.
    if (opts.manageTaskStatus && anchor.kind === 'task') {
      await safeWrite('task queued', () => setTaskStatus(integration.apiKey, anchor.pageId, 'Queued'));
    }
    if (opts.discussionId) {
      await safeWrite('queue note', () => postAgentReply(integration.apiKey, opts.discussionId!,
        `**@${agentRef.name}** is busy — this is queued (position ${position}) and will run as soon as a slot frees up.`));
    }
    return;
  }

  const reservation = mintReservation(anchor, agentRef, opts, projectId, 'work');
  await runReserved(integration, anchor, agentRef, opts, reservation);
}

export type ExternalClaim =
  | { mode: 'dispatched'; runId: string; token: string }
  | { mode: 'queued'; position: number; pending: number; reason: string };

/**
 * Claim a task for an agent that is ALREADY engaged with a human outside NORC
 * (Slack, chat, …) — the out-of-band intake (/api/me/tasks). Unlike a normal
 * dispatch, NO prompt is sent through the adapter: when capacity allows, a run
 * is minted "self-claimed" and the agent does the work in its live external
 * session, reporting through the standard run API until /complete. When the
 * agent is busy (cap, or in-flight work on the same project/page), the task is
 * enqueued with PRIORITY — it drains ahead of normal work, through the normal
 * adapter dispatch, carrying the original out-of-band request.
 *
 * Double-dispatch guards: the Notion writes here are bot-authored (dropped by
 * the webhook loop guard), and both idempotency keys are pre-marked — exactly
 * like createTaskFromWork — so a later HUMAN edit of the task page doesn't
 * re-fire the assignment.
 */
export async function claimExternalTask(
  integration: Integration,
  agentRow: typeof agents.$inferSelect,
  taskPageId: string,
  request: string,
  source: string,
): Promise<ExternalClaim> {
  const apiKey = integration.apiKey;
  const anchor = await resolveAnchor(apiKey, taskPageId);
  const projectId = projectIdForAnchor(anchor);
  const title = getAnyTitle((anchor.page as Record<string, unknown>)['properties']) || null;
  const orgDbPageId = agentRow.orgDbPageId ?? '';

  // Idempotency keys FIRST (mirrors createTaskFromWork): the creation/claim is
  // handled here — webhooks for this page must not re-triage or re-dispatch it.
  markProcessed(`triage:${taskPageId}`);
  markProcessed(`page:${taskPageId}:${agentRow.id}`);
  // If this task was already parked in this agent's queue (e.g. claiming a
  // previously Queued task), the claim supersedes the parked turn.
  dropPendingForAgentPage(agentRow.id, taskPageId, `claimed via external request (${source})`);

  // ── sync gate: check → (enqueue | mint) without yielding the event loop ──
  const atCapacity = activeRunCount(agentRow.id) >= agentRow.maxConcurrentRuns;
  const conflicted = hasRunConflict(agentRow.id, projectId, taskPageId);
  if (atCapacity || conflicted) {
    const { position } = enqueueTurn({
      agentId: agentRow.id,
      pageId: taskPageId,
      taskPageId,
      projectId,
      anchorKind: 'task',
      title,
      payload: { request, manageTaskStatus: true, how: `external request (${source})` },
      priority: 1,
    });
    const reason = conflicted ? 'an in-flight run on the same project/page' : `the cap of ${agentRow.maxConcurrentRuns}`;
    emitLog(`external task queued with PRIORITY for "${agentRow.name}" (position ${position}, via ${source}) on task ${taskPageId} — blocked by ${reason}`, agentRow.name, taskPageId);
    await safeWrite('task queued', () => setTaskStatus(apiKey, taskPageId, 'Queued'));
    if (orgDbPageId) await safeWrite('task assignee', () => setTaskAssignee(apiKey, taskPageId, [orgDbPageId]));
    return { mode: 'queued', position, pending: pendingCount(agentRow.id), reason };
  }

  const { id: runId, token } = createRun({
    agentId: agentRow.id,
    pageId: taskPageId,
    taskPageId,
    anchorKind: 'task',
    title,
    projectId,
    lane: 'work',
    manageTaskStatus: true,
  });

  // Write-FIRST, same order as a normal dispatch: agent Busy + task In Progress
  // before the agent starts working (visibility even if it stalls).
  if (orgDbPageId) {
    await safeWrite('agent busy', () => setAgentStatus(apiKey, orgDbPageId, 'Busy'));
    await safeWrite('last active', () => touchLastActive(apiKey, orgDbPageId));
  }
  await safeWrite('task in-progress', () => setTaskStatus(apiKey, taskPageId, 'In Progress'));
  if (orgDbPageId) await safeWrite('task assignee', () => setTaskAssignee(apiKey, taskPageId, [orgDbPageId]));

  emitLog(`"${agentRow.name}" self-claimed task ${taskPageId} (via ${source}, run ${runId}) — working in its external session, awaiting Agent API callback`, agentRow.name, taskPageId);
  return { mode: 'dispatched', runId, token };
}

// One drain at a time per agent; a drain requested mid-drain re-runs once after.
const drainInProgress = new Set<string>();
const drainAgain = new Set<string>();

/**
 * Dispatch as much of an agent's queued work as now fits. Two phases per item:
 * an async freshness phase (re-resolve the anchor — the world may have changed
 * while the item waited) and a SYNC commit phase (claimAndCheck → createRun in
 * one tick, so the capacity invariants hold against concurrent webhook turns).
 */
export async function drainAgent(agentId: string): Promise<void> {
  if (drainInProgress.has(agentId)) {
    drainAgain.add(agentId);
    return;
  }
  drainInProgress.add(agentId);
  try {
    while (true) {
      const agentRow = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
      if (!agentRow) break;
      if (activeRunCount(agentId) >= agentRow.maxConcurrentRuns) break;
      const item = nextEligible(agentId);
      if (!item) break;
      const integration = db.select().from(notionIntegration).all()[0] ?? null;
      if (!integration || integration.status !== 'active') break;

      const dispatched = await dispatchQueuedItem(integration, agentRow, item);
      if (!dispatched) continue; // item was dropped — try the next one
    }
  } finally {
    drainInProgress.delete(agentId);
    if (drainAgain.delete(agentId)) setImmediate(() => void drainAgent(agentId));
  }
}

/** Drain one queued item. Returns false when the item was dropped (caller moves
 * on) and true when it was dispatched or the drain should stop retrying. */
async function dispatchQueuedItem(integration: Integration, agentRow: typeof agents.$inferSelect, item: DispatchQueueRow): Promise<boolean> {
  const apiKey = integration.apiKey;
  const agentRef: AgentRef = {
    agentId: agentRow.id, orgDbPageId: agentRow.orgDbPageId ?? '',
    name: agentRow.name, adapterType: agentRow.adapterType,
  };
  let payload: QueuedTurn;
  try { payload = JSON.parse(item.payload) as QueuedTurn; } catch {
    dropItem(item.id, 'unreadable payload');
    return false;
  }

  // ── async freshness phase: the world may have moved while this waited ──
  let anchor: Anchor;
  try {
    anchor = await resolveAnchor(apiKey, item.pageId);
  } catch {
    dropItem(item.id, 'page unreadable');
    return false;
  }
  const page = anchor.page as Record<string, unknown>;
  if (page['archived'] === true || page['in_trash'] === true) {
    dropItem(item.id, 'page archived');
    return false;
  }
  if (anchor.kind === 'task') {
    const status = getSelect(page['properties'], 'Status') ?? '';
    if (isInertTaskStatus(status)) {
      // A human parked it while it waited — release the idempotency key so
      // flipping it back to Backlog re-fires normally.
      dropItem(item.id, `task went ${status || 'empty'}`);
      unmarkProcessed(`page:${item.pageId}:${item.agentId}`);
      return false;
    }
    if (status === 'Done' || status === 'Failed') {
      dropItem(item.id, `task already ${status}`);
      return false;
    }
    const unmet = await unmetDependencies(apiKey, page['properties']);
    if (unmet.length > 0) {
      // Dependencies appeared while it waited — releaseDependents re-dispatches
      // when they complete; free the trigger key so that path can fire.
      dropItem(item.id, `waiting on ${unmet.length} dependenc${unmet.length === 1 ? 'y' : 'ies'}`);
      unmarkProcessed(`page:${item.pageId}:${item.agentId}`);
      return false;
    }
  }
  const thread = await listThreadComments(apiKey, payload.threadBlockId ?? item.pageId).catch(() => [] as ThreadComment[]);

  // ── sync commit phase: claim + mint in one tick ──
  if (!claimAndCheck(item.id, item.agentId, item.projectId, item.pageId, agentRow.maxConcurrentRuns)) {
    // Capacity vanished during the freshness phase (a webhook turn won the
    // race) — leave the item pending; the next run.finished drains it.
    return true;
  }
  const opts: TurnOpts = {
    thread,
    request: payload.request,
    ...(payload.triggeringCommentId ? { triggeringCommentId: payload.triggeringCommentId } : {}),
    ...(payload.discussionId !== undefined ? { discussionId: payload.discussionId } : {}),
    ...(payload.commentedText ? { commentedText: payload.commentedText } : {}),
    ...(payload.triggeringUserId !== undefined ? { triggeringUserId: payload.triggeringUserId } : {}),
    ...(payload.threadBlockId ? { threadBlockId: payload.threadBlockId } : {}),
    manageTaskStatus: payload.manageTaskStatus,
    how: `${payload.how} (dequeued)`,
  };
  const reservation = mintReservation(anchor, agentRef, opts, item.projectId, 'work');
  emitLog(`dequeued for "${agentRef.name}" on ${anchor.kind} page ${item.pageId} (queued ${Math.round((Date.now() - item.enqueuedAt) / 1000)}s)`, agentRef.name, item.pageId);
  await runReserved(integration, anchor, agentRef, opts, reservation);
  return true;
}

/** Assemble context, dispatch (with a run token + contract), reply, drive status. */
async function runAgentTurn(integration: Integration, anchor: Anchor, agentRef: AgentRef, opts: TurnOpts, reservation?: Reservation): Promise<void> {
  const apiKey = integration.apiKey;
  const agentRow = db.select().from(agents).where(eq(agents.id, agentRef.agentId)).all()[0];
  if (!agentRow) {
    emitLog(`dispatch skipped: agent "${agentRef.name}" no longer registered`, agentRef.name);
    return;
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(agentRow.adapterConfig); } catch { config = {}; }
  const adapterType = agentRow.adapterType as AdapterType;

  emitEvent({
    type: 'mention.detected',
    data: { agentId: agentRef.agentId, agentName: agentRef.name, pageId: anchor.pageId, anchorKind: anchor.kind },
  });

  const ctx = await assembleContext({ apiKey, anchor, agentRef, request: opts.request });

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
  // firstVisit comes from the reservation when there is one — it was computed
  // BEFORE the run was minted, so the fresh run doesn't shadow it.
  const pageRef: PageRef | undefined = anchor.kind === 'page'
    ? {
        title: getAnyTitle((anchor.page as Record<string, unknown>)['properties']),
        url: typeof (anchor.page as Record<string, unknown>)['url'] === 'string'
          ? (anchor.page as Record<string, unknown>)['url'] as string
          : null,
        firstVisit: reservation ? reservation.firstVisit : !hasPriorRunOnPage(agentRef.agentId, anchor.pageId),
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
    emitLog(`prompt preview for "${agentRef.name}" (${adapterType}, ${system.length + prompt.length} chars) — dispatch not wired`, agentRef.name);
    emitLog(`prompt preview content >>> ${JSON.stringify({ system, prompt })}`, agentRef.name);
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

  // The run is normally pre-minted by requestAgentTurn (the capacity gate) in
  // the same tick as its checks; mint here only for direct callers.
  const { runId, token } = reservation
    ?? mintReservation(anchor, agentRef, opts, projectIdForAnchor(anchor), opts.lane ?? 'work');
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
    // Tell the human, in Notion, that NORC handed this off — so the dispatch and
    // its context level are visible (not just in the internal log).
    await safeWrite('dispatch notice', () => postAgentComment(apiKey, anchor.pageId,
      `🛰️ **NORC** dispatched this to **@${agentRef.name}** (context: ${ctx.contextLevel}). Working on it…`));
  }

  // Chat-lane turns get their own session so a parallel conversation never
  // collides with (or pollutes) the in-flight task run's per-page memory.
  const lane = reservation?.lane ?? opts.lane ?? 'work';
  const sessionId = lane === 'chat' ? `${anchor.pageId}#chat` : anchor.pageId;

  emitLog(`dispatching to "${agentRef.name}" (${adapterType}, level=${ctx.contextLevel}, via ${opts.how}, run ${runId}) on ${anchor.kind} page ${anchor.pageId}`, agentRef.name);
  const result = await dispatch({ adapterType, config, system, prompt, agentName: agentRef.name, sessionId });

  if (!result.ok) {
    const failMsg = `**@${agentRef.name}** failed ✗ — ${result.error}`;
    if (opts.discussionId) await safeWrite('reply on text', () => postAgentReply(apiKey, opts.discussionId!, failMsg));
    else await postAgentComment(apiKey, anchor.pageId, failMsg);
    if (opts.manageTaskStatus) await safeWrite('task failed', () => setTaskStatus(apiKey, anchor.pageId, 'Failed'));
    await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
    finalizeRun(runId, 'failed');
    emitLog(`dispatch failed for "${agentRef.name}": ${result.error}`, agentRef.name);
    return;
  }

  // Async adapter (openclaw WS): dispatched, but the reply arrives later via the
  // Agent API. Leave the run in-flight (Status already In Progress, agent Busy);
  // the agent's /complete — or the timeout sweep — finalizes it.
  if (result.async) {
    emitLog(`dispatched to "${agentRef.name}" (async) — awaiting Agent API callback on ${anchor.kind} page ${anchor.pageId} (run ${runId})`, agentRef.name);
    return;
  }

  // If the agent already wrote via the Agent API during the run, respect that and
  // don't also post its text return. Finalize for it if it didn't call /complete.
  if (getRun(runId)?.agentActed) {
    if (getRun(runId)?.status === 'in_flight') {
      if (opts.manageTaskStatus) {
        await safeWrite('task done', () => setTaskStatus(apiKey, anchor.pageId, 'Done'));
        void releaseDependents(integration, anchor.pageId).catch(() => {});
      }
      await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
      finalizeRun(runId, 'done');
    }
    emitLog(`"${agentRef.name}" completed via Agent API on ${anchor.kind} page ${anchor.pageId}`, agentRef.name);
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
      void releaseDependents(integration, anchor.pageId).catch(() => {});
    }
    await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
    finalizeRun(runId, 'done');
    emitLog(`"${agentRef.name}" completed on ${anchor.kind} page ${anchor.pageId}`, agentRef.name);
    return;
  }

  // Free page: write content into the page or reply on the precise text.
  await deliverPageReply(apiKey, anchor, opts, agentRef.name, text);
  await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
  finalizeRun(runId, 'done');
  emitLog(`"${agentRef.name}" completed on ${anchor.kind} page ${anchor.pageId}`, agentRef.name);
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
    emitLog(`outcome assessment failed: ${err instanceof Error ? err.message : 'unknown'}`, 'Triage');
    return false;
  }
  if (assessment.outcome !== 'blocked') return false;

  const need = assessment.need?.trim();
  emitLog(`"${agentRef.name}" is blocked${need ? ` (needs: ${need})` : ''} — re-routing`, agentRef.name);
  // The attempt is over: free the agent, revert the task, close this run.
  await safeWrite('agent available', () => setAgentStatus(apiKey, agentRef.orgDbPageId, 'Available'));
  await safeWrite('task backlog', () => setTaskStatus(apiKey, anchor.pageId, 'Backlog'));
  finalizeRun(runId, 'done');

  const prefix = `⚠️ **@${agentRef.name}** couldn't complete this${need ? ` — needs: ${need}` : ''}. Finding someone who can.`;
  const thread = await listThreadComments(apiKey, anchor.pageId).catch(() => [] as ThreadComment[]);
  await runTriage(integration, anchor, { text: need ?? '', thread }, [agentRef.name], prefix);
  return true;
}
