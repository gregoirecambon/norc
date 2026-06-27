// Slack-side orchestration: normalizes inbound Slack events into NORC's
// mention → context → dispatch → reply pipeline. The webhook route (and a
// future Socket Mode transport) feed handleSlackEvent(); everything Slack-
// specific downstream of the transport lives here.
//
// Two lanes, decided by the triage LLM (chat when unconfigured):
//   chat — a conversational ask. Runs on a SYNTHETIC anchor
//          (slack:<channel>:<threadRoot>), chat lane, no Notion writes; the
//          reply lands in the Slack thread as the agent.
//   task — actionable work. A REAL Notion task is created (duplicate-gated),
//          the run anchors on it and flows through the normal capacity gate;
//          Notion stays canonical and the completion summary returns to the
//          thread via slack-notify.

import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, agentSessions, taskRuns, notionIntegration, notionDatabases } from '../db/schema.js';
import { emitLog } from './logger.js';
import { emitEvent } from './events.js';
import { getSlack, isSlackActive, slackAnchorId, parseSlackAnchor } from './slack-integration.js';
import { postAsAgent, fetchThreadReplies, fetchChannelHistory, conversationsInfo, slackUserName, type SlackMessage } from './slack-client.js';
import { createRun, finalizeRun, getRun, setOpenclawRunId, setRunSessionId, type TaskRun } from './runs.js';
import { resolveSession } from './agent-sessions.js';
import { dispatch, dispatchSupported } from '../adapters/index.js';
import type { AdapterType } from '../types.js';
import { agentPersona, projectSection, assembleWithBudget, type Section } from './context-assembler.js';
import { norcBaseUrl } from './base-url.js';
import { getNorcSettings } from './norc-settings.js';
import { triage, classifyTaskWorthy, inferProjectForTask } from './orchestrator-agent.js';
import {
  requestAgentTurn, triageConfigured, rosterCandidates, matchAgentByName,
} from './orchestrator.js';
import { listOpenTasks, findBlockingSimilar } from './external-tasks.js';
import { projectForChannel, findProjectByName, listProjectNames, type ChannelProject } from './slack-notify.js';
import { agentSlackIcon } from './slack-agents.js';
import { createTaskPage, appendBlocks, setTaskProject } from './notion-writeback.js';
import { markdownToBlocks } from './notion-blocks-md.js';
import { resolveAnchor } from './notion-anchor.js';
import { getSelect } from './notion-props.js';
import { alreadyProcessed, markProcessed } from './processed-triggers.js';
import type { AgentRef } from './notion-mentions.js';

export { slackAnchorId, isSlackAnchor, parseSlackAnchor } from './slack-integration.js';

// The inner `event` object of an event_callback envelope. Only the fields the
// orchestrator reads — Slack sends many more.
export interface SlackInnerEvent {
  type: string;                 // 'app_mention' | 'message' | ...
  subtype?: string;             // 'message_changed', 'bot_message', ...
  user?: string;                // human author
  bot_id?: string;              // set on bot-authored messages (loop guard)
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;        // 'channel' | 'group' | 'im'
}

export interface SlackEventEnvelope {
  teamId: string | null;
  event: SlackInnerEvent;
}

const MAX_PROMPT_CHARS = 24_000;
const MAX_THREAD_MSGS = 30;

// ─── Mention parsing ────────────────────────────────────────────────────────

export interface ParsedMention {
  /** Agents explicitly tagged (user-group handle or "@Norc Name" fallback). */
  agents: AgentRef[];
  /** The Norc bot itself was @mentioned (or this is a DM). */
  norc: boolean;
  /** The text with mention tokens stripped — the actual ask. */
  request: string;
}

/** Registered agents resolvable from a Slack message: subteam (user-group)
 * tokens first, then a leading agent-name after the bot mention. Only
 * Slack-enabled agents are targetable — the per-agent dashboard toggle. */
export function parseSlackMentions(text: string, botUserId: string | null, isDm = false): ParsedMention {
  const found: AgentRef[] = [];
  const seen = new Set<string>();

  // <!subteam^S0123|@handle> — per-agent user groups (when provisioned).
  const slackAgents = db.select().from(agents).all().filter(a => a.slackEnabled);
  for (const m of text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    const subteamId = m[1]!;
    const row = slackAgents.find(a => a.slackUsergroupId === subteamId);
    if (row?.orgDbPageId && !seen.has(row.id)) {
      seen.add(row.id);
      found.push({ agentId: row.id, orgDbPageId: row.orgDbPageId, name: row.name, adapterType: row.adapterType });
    }
  }

  const norc = isDm || (!!botUserId && text.includes(`<@${botUserId}>`));

  // Strip every mention token to recover the plain request. Channel tokens
  // (<#C0123|app-lutai>) are unwrapped, keeping the id visible so agents can
  // pass it straight to the /slack endpoint.
  let request = text
    .replace(/<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/g, ' ')
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2 (channel id $1)')
    .replace(/<#([A-Z0-9]+)>/g, 'channel $1')
    .replace(/\s+/g, ' ')
    .trim();

  // Fallback handle: "@Norc ResearchAgent do X" — a leading agent name right
  // after the bot mention targets that agent (works on free Slack plans).
  if (norc && found.length === 0 && request) {
    const lower = request.toLowerCase();
    const byLength = [...slackAgents].sort((a, b) => b.name.length - a.name.length);
    for (const row of byLength) {
      const n = row.name.toLowerCase();
      if ((lower === n || lower.startsWith(n + ' ') || lower.startsWith(n + ':') || lower.startsWith(n + ',')) && row.orgDbPageId) {
        found.push({ agentId: row.id, orgDbPageId: row.orgDbPageId, name: row.name, adapterType: row.adapterType });
        request = request.slice(row.name.length).replace(/^[\s:,]+/, '').trim();
        break;
      }
    }
  }

  return { agents: found, norc, request };
}

// ─── Thread context ─────────────────────────────────────────────────────────

interface SlackThreadLine {
  author: string;
  text: string;
}

const userNameCache = new Map<string, { name: string; at: number }>();
const USER_NAME_TTL_MS = 10 * 60_000;

async function displayName(token: string, userId: string): Promise<string> {
  const hit = userNameCache.get(userId);
  if (hit && Date.now() - hit.at < USER_NAME_TTL_MS) return hit.name;
  const name = (await slackUserName(token, userId)) ?? userId;
  userNameCache.set(userId, { name, at: Date.now() });
  return name;
}

/** The thread so far, rendered as "author: text" lines (latest message last,
 * the triggering message excluded by ts). The 'dm' branch only serves runs
 * minted by v0.11.5 (legacy rolling-DM anchors) still in flight. */
async function threadLines(token: string, channel: string, threadRoot: string, excludeTs: string): Promise<SlackThreadLine[]> {
  let msgs: SlackMessage[] = [];
  try {
    msgs = threadRoot === 'dm'
      ? await fetchChannelHistory(token, channel, MAX_THREAD_MSGS)
      : await fetchThreadReplies(token, channel, threadRoot, MAX_THREAD_MSGS);
  } catch { return []; }
  const out: SlackThreadLine[] = [];
  for (const m of msgs) {
    if (m.ts === excludeTs || !m.text.trim()) continue;
    const author = m.username ?? (m.botId ? 'NORC' : m.userId ? await displayName(token, m.userId) : 'unknown');
    out.push({ author, text: m.text.trim() });
  }
  return out;
}

/** The /context payload for a Slack-chat run (no Notion anchor exists):
 * the thread conversation + the channel's bound project, when any. */
export async function slackChatContext(run: TaskRun): Promise<Record<string, unknown>> {
  const where = parseSlackAnchor(run.pageId);
  const { botToken } = getSlack();
  const conversation = where && botToken
    ? (await threadLines(botToken, where.channel, where.threadTs, '')).map(l => `${l.author}: ${l.text}`)
    : [];
  const project = where ? await projectForChannel(where.channel) : null;
  return {
    contextLevel: 'project',
    anchorKind: 'slack',
    slackChannel: where?.channel ?? null,
    slackThreadTs: where?.threadTs ?? null,
    conversation,
    project: project?.block ?? null,
    task: null,
    company: [],
    related: [],
    projectResources: [],
    body: '',
    projectBody: '',
  };
}

// ─── Event entry point ──────────────────────────────────────────────────────

/** Entry point for one inbound Slack event (already acked + deduped by the
 * transport — a future Socket Mode client calls this directly). */
export async function handleSlackEvent(envelope: SlackEventEnvelope): Promise<void> {
  const ev = envelope.event;
  const slack = getSlack();
  if (!slack.botToken || !isSlackActive()) return;

  // Loop guard: never react to bot-authored messages (ours or anyone's), nor
  // to edits/joins/etc. — only fresh human messages.
  if (ev.bot_id || (slack.botUserId && ev.user === slack.botUserId)) return;
  if (ev.subtype) return;
  if (ev.type !== 'app_mention' && ev.type !== 'message') return;
  if (!ev.channel || !ev.ts || !ev.text || !ev.user) return;

  // app_mention and message.* both deliver bot mentions — process each
  // message once, whichever envelope lands first.
  const msgKey = `slack:msg:${ev.channel}:${ev.ts}`;
  if (alreadyProcessed(msgKey)) return;
  markProcessed(msgKey);

  const isDm = ev.channel_type === 'im';
  // Conversation model (Notion's): every top-level message STARTS a thread —
  // the agent replies under it, and that thread is the conversation. Context
  // is always thread-scoped; the surrounding channel/DM history is never
  // dumped into the prompt (channels are long; only the thread is relevant).
  const isThreadReply = !!ev.thread_ts;
  const threadRoot = ev.thread_ts ?? ev.ts;
  const parsed = parseSlackMentions(ev.text, slack.botUserId, isDm);

  // Prefer the agent already engaged in this conversation (Notion's UX — no
  // re-tagging every message); untargeted channel chatter outside an engaged
  // thread is ignored.
  let target: AgentRef | null = parsed.agents[0] ?? null;
  if (!target) target = continuationAgent(ev.channel, threadRoot);

  const request = parsed.request || '(no message text)';

  // A thread reply can continue an existing conversation even when the human
  // didn't re-tag anyone — so a bare "PGT v2.0" still lands. Handle these BEFORE
  // the "addressed to us?" guard; both no-op (return false) unless they match a
  // real task in this thread, so they never swallow ordinary chatter.
  //   • resumeThreadTask    — the thread's task is parked Blocked → answer it
  //   • relinkProjectFromReply — we asked "which project?" → apply the answer
  if (isThreadReply) {
    const replier = await displayName(slack.botToken, ev.user);
    if (await resumeThreadTask({
      botToken: slack.botToken, channel: ev.channel, threadRoot, target, request, asker: replier,
    })) return;
    if (await relinkProjectFromReply({
      botToken: slack.botToken, channel: ev.channel, threadRoot, request,
    })) return;
  }

  if (!target && !parsed.norc) return;

  emitLog(`slack ${isDm ? 'DM' : `message in ${ev.channel}`}${target ? ` → @${target.name}` : parsed.norc ? ' → NORC' : ''}: ${request.slice(0, 140)}`, 'Slack');

  // Thread replies carry their thread as context; a top-level message stands
  // alone (it OPENS the conversation — nothing precedes it).
  const thread = isThreadReply ? await threadLines(slack.botToken, ev.channel, threadRoot, ev.ts) : [];
  const asker = await displayName(slack.botToken, ev.user);

  // Chat vs task — the triage LLM decides; on error/unconfigured default to
  // chat (never block a conversation).
  const settings = getNorcSettings();
  let taskVerdict: { task: boolean; title?: string; kpis?: string; project?: string } = { task: false };
  if (triageConfigured(settings)) {
    try {
      taskVerdict = await classifyTaskWorthy({
        provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
        apiKey: settings!.orchestratorApiKey ?? '',
        baseUrl: settings!.orchestratorBaseUrl,
        model: settings!.orchestratorModel,
        kind: 'slack message',
        title: isDm ? 'direct message' : `Slack channel ${ev.channel}`,
        text: request,
        conversation: thread.map(l => `${l.author}: ${l.text}`),
        projects: await listProjectNames().catch(() => []),
      });
    } catch { /* stay chat */ }
  }

  if (taskVerdict.task) {
    await handleTaskAsk({
      botToken: slack.botToken, channel: ev.channel, threadRoot,
      target, request, asker, thread,
      title: taskVerdict.title || request.slice(0, 80),
      kpis: taskVerdict.kpis ?? '',
    });
    return;
  }

  // ── chat lane ──
  if (!target) {
    target = await routeViaTriage(slack.botToken, ev.channel, threadRoot, request, thread);
    if (!target) return; // triage already answered in-thread
  }
  await runSlackChatTurn({
    botToken: slack.botToken, agentRef: target,
    channel: ev.channel, threadRoot, request, asker, thread,
  });
}

/**
 * A reply in a thread that already drove a Notion task continues THAT task —
 * same page, hence the same agent session — instead of minting a sibling.
 * Applies when the thread's latest task is parked **Blocked** (an agent asked
 * for human input and this reply answers it); in-flight or finished tasks fall
 * through to the normal chat/task lanes. Returns true when it took the turn.
 */
async function resumeThreadTask(args: {
  botToken: string;
  channel: string;
  threadRoot: string;
  target: AgentRef | null;
  request: string;
  asker: string;
}): Promise<boolean> {
  const { botToken, channel, threadRoot, target, request, asker } = args;
  const prior = db.select().from(taskRuns)
    .where(and(eq(taskRuns.slackChannel, channel), eq(taskRuns.slackThreadTs, threadRoot), eq(taskRuns.lane, 'work')))
    .all()
    .filter(r => r.taskPageId)
    .at(-1);
  if (!prior?.taskPageId) return false;

  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active') return false;

  let anchor;
  try { anchor = await resolveAnchor(integration.apiKey, prior.taskPageId); } catch { return false; }
  const status = getSelect((anchor.page as Record<string, unknown>)['properties'], 'Status');
  if (status !== 'Blocked') return false;

  // Same agent (same session) unless the human explicitly tagged another one.
  const agentRow = db.select().from(agents).where(eq(agents.id, target?.agentId ?? prior.agentId)).all()[0];
  if (!agentRow?.orgDbPageId) return false;
  const agentRef: AgentRef = { agentId: agentRow.id, orgDbPageId: agentRow.orgDbPageId, name: agentRow.name, adapterType: agentRow.adapterType };

  emitLog(`slack reply unblocks "${prior.title ?? prior.taskPageId}" → @${agentRef.name} (same task, same session)`, 'Slack', prior.taskPageId);
  // Audit trail on the task page (bot-authored — the webhook loop guard eats it).
  await appendBlocks(integration.apiKey, prior.taskPageId,
    markdownToBlocks(`**${asker}** replied in Slack: ${request}`)).catch(() => undefined);
  markProcessed(`page:${prior.taskPageId}:${agentRef.agentId}`);

  const url = `https://www.notion.so/${prior.taskPageId.replace(/-/g, '')}`;
  await postAsAgent(botToken, {
    channel, threadTs: threadRoot, agentName: 'NORC',
    text: `Passing your answer to @${agentRef.name} — resuming <${url}|${prior.title ?? 'the task'}>.`,
  }).catch(() => undefined);

  await requestAgentTurn(integration, anchor, agentRef, {
    thread: [],
    request: `${asker} replied in Slack to your blocked report: ${request}`,
    triggeringUserId: null,
    lane: 'work',
    manageTaskStatus: prior.manageTaskStatus,
    how: 'slack follow-up on blocked task',
    slackChannel: channel,
    slackThreadTs: threadRoot,
  });
  return true;
}

/** Work-lane runs spawned from this Slack conversation, rendered for the chat
 * prompt — the agent can answer "so, how's it going?" with real status. */
function tasksFromThread(channel: string, threadRoot: string): string[] {
  const rows = db.select().from(taskRuns)
    .where(and(eq(taskRuns.slackChannel, channel), eq(taskRuns.slackThreadTs, threadRoot), eq(taskRuns.lane, 'work')))
    .all()
    .slice(-5);
  return rows.map(r => {
    const age = Math.round((Date.now() - r.createdAt) / 60_000);
    const state = r.status === 'in_flight' ? `in progress (started ${age}m ago)` : r.status.replace('_', ' ');
    const url = r.taskPageId ? ` — https://www.notion.so/${r.taskPageId.replace(/-/g, '')}` : '';
    return `- "${r.title ?? 'task'}": ${state}${url}`;
  });
}

/** The single agent already conversing in this thread (session exists), if
 * exactly one — otherwise null (ambiguous → require an explicit tag). */
function continuationAgent(channel: string, threadRoot: string): AgentRef | null {
  const anchorId = slackAnchorId(channel, threadRoot);
  const rows = db.select().from(agentSessions)
    .where(and(eq(agentSessions.pageId, anchorId), eq(agentSessions.lane, 'chat')))
    .all();
  const ids = [...new Set(rows.map(r => r.agentId))];
  if (ids.length !== 1) return null;
  const row = db.select().from(agents).where(eq(agents.id, ids[0]!)).all()[0];
  if (!row?.orgDbPageId) return null;
  return { agentId: row.id, orgDbPageId: row.orgDbPageId, name: row.name, adapterType: row.adapterType };
}

/** Plain @Norc with no agent: pick one via the triage LLM, announcing the
 * routing (or the question back to the human) in the thread as NORC. */
async function routeViaTriage(botToken: string, channel: string, threadRoot: string, request: string, thread: SlackThreadLine[]): Promise<AgentRef | null> {
  const settings = getNorcSettings();
  const say = (text: string) =>
    postAsAgent(botToken, { channel, text, threadTs: threadRoot, agentName: 'NORC' }).catch(() => undefined);

  // Only Slack-enabled agents are reachable from Slack (the dashboard toggle).
  const enabledNames = new Set(db.select().from(agents).all().filter(a => a.slackEnabled).map(a => a.name));
  const candidates = rosterCandidates([]).filter(c => enabledNames.has(c.name));
  if (candidates.length === 0) {
    await say('No Slack-enabled agents are available — enable one on the NORC dashboard (Agents → Slack toggle).');
    return null;
  }
  if (candidates.length === 1) return matchAgentByName(candidates[0]!.name);
  if (!triageConfigured(settings)) {
    await say(`Several agents are available (${candidates.map(c => c.name).join(', ')}) — tag one by name, e.g. "@Norc ${candidates[0]!.name} …".`);
    return null;
  }

  try {
    const decision = await triage({
      provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
      apiKey: settings!.orchestratorApiKey ?? '',
      baseUrl: settings!.orchestratorBaseUrl,
      model: settings!.orchestratorModel,
      systemPrompt: settings!.orchestratorSystemPrompt ?? undefined,
      kind: 'slack conversation', title: `Slack channel ${channel}`,
      text: request, conversation: thread.map(l => `${l.author}: ${l.text}`),
      candidates,
    });
    // Slack triage passes no chores, so the decision is route/suggest/ignore; narrow
    // before reading .agent (the 'chore' variant has no agent field).
    const routed = (decision.decision === 'route' || decision.decision === 'suggest') && decision.agent
      ? matchAgentByName(decision.agent) : null;
    if (routed) {
      // Chat is low-stakes — a suggested agent answers too (no confirm round-trip).
      return routed;
    }
    await say(decision.message?.trim() || `Which agent should take this? (${candidates.map(c => c.name).join(', ')})`);
  } catch (err) {
    emitLog(`slack triage error: ${err instanceof Error ? err.message : 'unknown'}`, 'Slack');
    await say(`Tag an agent by name and I'll pass it on (${candidates.map(c => c.name).join(', ')}).`);
  }
  return null;
}

// ─── Chat lane: synthetic-anchor dispatch ───────────────────────────────────

function slackRunBlock(runId: string, token: string, channel: string, threadRoot: string, asyncAdapter: boolean): string {
  // Async adapters (openclaw) MUST reply through the API: their plain text
  // return only reaches Slack when the socket capture wins a race against the
  // session closing. Sync adapters return text and NORC posts it.
  const replyContract = asyncAdapter
    ? [
        `This is a Slack conversation. REPLY BY API — your plain text return may never reach Slack:`,
        `  curl -s -X POST <api_base>/comment -H 'Content-Type: application/json' -d '{"text":"your reply"}'`,
        `Then finish:  curl -s -X POST <api_base>/complete -H 'Content-Type: application/json' -d '{"status":"done"}'`,
      ]
    : [
        `This is a Slack conversation: just return your reply as text (NORC posts it to the thread),`,
        `or POST {"text":"…"} to <api_base>/comment.`,
      ];
  return [
    `run_id: ${runId}`,
    `slack_channel: ${channel}`,
    `slack_thread_ts: ${threadRoot}`,
    `api_base: ${norcBaseUrl()}/api/runs/${token}`,
    ...replyContract,
    `Use your NORC skill for the full API.`,
  ].join('\n');
}

async function runSlackChatTurn(args: {
  botToken: string;
  agentRef: AgentRef;
  channel: string;
  threadRoot: string;
  request: string;
  asker: string;
  thread: SlackThreadLine[];
}): Promise<void> {
  const { botToken, agentRef, channel, threadRoot, request, asker, thread } = args;
  const integration = db.select().from(notionIntegration).all()[0];
  const apiKey = integration?.status === 'active' ? integration.apiKey : null;

  const agentRow = db.select().from(agents).where(eq(agents.id, agentRef.agentId)).all()[0];
  if (!agentRow) return;
  const adapterType = agentRow.adapterType as AdapterType;
  if (!dispatchSupported(adapterType)) {
    await postAsAgent(botToken, {
      channel, threadTs: threadRoot, agentName: 'NORC',
      text: `@${agentRef.name} uses the "${adapterType}" adapter, which isn't dispatchable yet — try another agent.`,
    }).catch(() => undefined);
    return;
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(agentRow.adapterConfig); } catch { config = {}; }

  const anchorId = slackAnchorId(channel, threadRoot);
  const channelInfo = await conversationsInfo(botToken, channel).catch(() => null);
  const channelLabel = channelInfo?.name ? `#${channelInfo.name}` : channel;

  // Persona + (optional) bound-project context, exactly like the Notion path.
  const persona = apiKey
    ? await agentPersona(apiKey, agentRef.orgDbPageId)
    : { systemPrompt: 'You are an AI agent talking with your team on Slack. Reply with one helpful, concise message.', contextLevel: 'project' as const };
  const project = await projectForChannel(channel);

  const { id: runId, token } = createRun({
    agentId: agentRef.agentId,
    pageId: anchorId,
    taskPageId: null,
    anchorKind: 'slack',
    title: `Slack ${channelLabel}`,
    projectId: project?.projectId ?? null,
    lane: 'chat',
    manageTaskStatus: false,
    origin: 'slack',
    slackChannel: channel,
    slackThreadTs: threadRoot,
  });

  const sections: Section[] = [];
  let order = 0;
  const push = (text: string, priority: number) => { sections.push({ text, priority, order: order++ }); };
  push(`[SLACK]\nYou are talking in a thread in the Slack ${channelInfo?.isIm ? 'DM' : `channel ${channelLabel}`}. Reply conversationally — one concise message, Slack-formatted (plain text, *bold*, bullets). Do not use Notion-style markdown headers.`, 1);
  if (project) push(`[CONTEXT]\n${projectSection(project.block)}`, 3);
  if (thread.length) push(`[CONVERSATION SO FAR]\n${thread.map(l => `${l.author}: ${l.text}`).join('\n')}`, 2);
  // Tasks NORC spawned from this very conversation — so "how is it going?"
  // and "so?" have something real to answer from.
  const threadTaskLines = tasksFromThread(channel, threadRoot);
  if (threadTaskLines.length) push(`[CONVERSATION TASKS]\nWork NORC created from this conversation (answer status questions from this):\n${threadTaskLines.join('\n')}`, 2);
  push(`[REQUEST]\n${asker} asks: ${request}`, 1);
  push(`[NORC RUN]\n${slackRunBlock(runId, token, channel, threadRoot, adapterType === 'openclaw')}`, 1);
  const prompt = assembleWithBudget(sections, MAX_PROMPT_CHARS);

  const fingerprint = createHash('sha256')
    .update(JSON.stringify([persona.systemPrompt, project ? projectSection(project.block) : null]))
    .digest('hex');
  const { sessionId, reused } = resolveSession({
    agentId: agentRef.agentId, pageId: anchorId, lane: 'chat',
    fingerprint, adapterType,
  });

  emitLog(`dispatching to "${agentRef.name}" (${adapterType}, slack chat, run ${runId}) in ${channelLabel} — ${reused ? `reusing session ${sessionId}` : `new session ${sessionId}`}`, agentRef.name);
  emitEvent({ type: 'mention.detected', data: { agentId: agentRef.agentId, agentName: agentRef.name, pageId: anchorId, anchorKind: 'slack' } });

  let result;
  try {
    result = await dispatch({ adapterType, config, system: persona.systemPrompt, prompt, agentName: agentRef.name, sessionId });
  } catch (err) {
    finalizeRun(runId, 'failed');
    await postAsAgent(botToken, {
      channel, threadTs: threadRoot, agentName: 'NORC',
      text: `⚠️ Couldn't reach @${agentRef.name}: ${err instanceof Error ? err.message : 'unknown error'}`,
    }).catch(() => undefined);
    return;
  }
  setRunSessionId(runId, result.sessionKey ?? sessionId);

  if (!result.ok) {
    finalizeRun(runId, 'failed');
    await postAsAgent(botToken, {
      channel, threadTs: threadRoot, agentName: 'NORC',
      text: `⚠️ @${agentRef.name} failed to answer: ${result.error ?? 'unknown error'}`,
    }).catch(() => undefined);
    return;
  }

  // Async adapter: the reply arrives via the Agent API (/comment or /complete);
  // the synthetic-anchor branch in finalizeAgentReport posts it to this thread.
  if (result.async) {
    if (result.openclawRunId) setOpenclawRunId(runId, result.openclawRunId);
    emitLog(`dispatched to "${agentRef.name}" (async, no sync text captured) — awaiting Agent API reply for Slack thread (run ${runId})`, agentRef.name);
    return;
  }
  emitLog(`captured sync reply from "${agentRef.name}" (${(result.text ?? '').length} chars) for Slack thread (run ${runId})`, agentRef.name);

  // The agent may have already replied through /comment — don't double-post.
  const run = getRun(runId);
  if (run?.agentActed) {
    if (run.status === 'in_flight') finalizeRun(runId, 'done');
    return;
  }
  const text = (result.text ?? '').trim() || '(no reply)';
  await postAsAgent(botToken, {
    channel, threadTs: threadRoot, agentName: agentRef.name, text,
    iconUrl: await agentSlackIcon(agentRef.agentId),
  }).catch(err =>
    emitLog(`slack reply post failed: ${err instanceof Error ? err.message : 'unknown'}`, agentRef.name));
  finalizeRun(runId, 'done');
  emitLog(`"${agentRef.name}" replied in Slack ${channelLabel} (run ${runId})`, agentRef.name);
}

// ─── Task lane: real Notion task from a Slack ask ───────────────────────────

/** "for project lutai", "on the LutAI project", "projet pgt" → the name token. */
export function extractProjectMention(text: string): string | null {
  const m = text.match(/(?:project|projet)\s*[:\-]?\s*["'«]?([\w][\w\- .]{0,40}?)["'»]?(?=[,;.!?\n]|\s+(?:and|et|then|please|stp|svp)\b|$)/i)
    ?? text.match(/(?:for|on|pour|sur)\s+(?:the\s+|le\s+|la\s+)?["'«]?([\w][\w\- .]{0,40}?)["'»]?\s+(?:project|projet)\b/i);
  const name = m?.[1]?.trim();
  return name && name.length >= 2 ? name : null;
}

// ─── Project resolution: which project does a Slack task belong to? ───────────
// The channel binding is the source of truth. A deliberate, explicit "for
// project X" in the message is the ONLY thing allowed to override it; soft LLM
// inference never does (that was the LutAI/PGT mis-assignment). Cascade:
//   1. explicit       — "…for project X" names a project that resolves
//   2. channel-binding — the channel's 'Slack Channel ID' in the Projects DB
//   3. channel-name    — the Slack channel name fuzzy-matches a project name
//   4. ai-inference    — a calibrated LLM guess, accepted only at confidence ≥ 0.9
//   5. none            — nothing confident → create unlinked and ASK in-thread

export type ProjectSource = 'explicit' | 'channel-binding' | 'channel-name' | 'ai-inference' | 'none';
export interface ResolvedProject {
  project: ChannelProject | null;
  source: ProjectSource;
}

const AI_PROJECT_CONFIDENCE = 0.9;

async function resolveSlackProject(args: {
  botToken: string;
  channel: string;
  request: string;
  title: string;
  thread: SlackThreadLine[];
}): Promise<ResolvedProject> {
  const { botToken, channel, request, title, thread } = args;

  // 1. Explicit, deliberate naming in the text — the one override of the binding.
  const explicit = extractProjectMention(request);
  if (explicit) {
    const named = await findProjectByName(explicit);
    if (named) return { project: named, source: 'explicit' };
    emitLog(`slack project: message names "${explicit}" but no project matches — falling back to the channel`, 'Slack');
  }

  // 2. Channel binding — the primary, deterministic signal.
  const bound = await projectForChannel(channel);
  if (bound) return { project: bound, source: 'channel-binding' };

  // 3. Channel NAME fuzzy match — e.g. #app-lutai → "lutai".
  const info = await conversationsInfo(botToken, channel).catch(() => null);
  if (info?.name) {
    const byName = await findProjectByName(info.name);
    if (byName) {
      emitLog(`slack project: channel #${info.name} (${channel}) is not bound — matched project "${byName.block.name}" by name`, 'Slack');
      return { project: byName, source: 'channel-name' };
    }
  }

  // 4. AI inference from the full context — accepted only when very confident.
  const settings = getNorcSettings();
  if (triageConfigured(settings)) {
    const projects = await listProjectNames().catch(() => []);
    if (projects.length) {
      try {
        const inf = await inferProjectForTask({
          provider: settings!.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
          apiKey: settings!.orchestratorApiKey ?? '',
          baseUrl: settings!.orchestratorBaseUrl,
          model: settings!.orchestratorModel,
          title, text: request,
          conversation: thread.map(l => `${l.author}: ${l.text}`),
          channelName: info?.name ?? null,
          projects,
        });
        if (inf.project && inf.confidence >= AI_PROJECT_CONFIDENCE) {
          const guessed = await findProjectByName(inf.project);
          if (guessed) {
            emitLog(`slack project: inferred "${guessed.block.name}" for ${channel} (confidence ${inf.confidence.toFixed(2)})`, 'Slack');
            return { project: guessed, source: 'ai-inference' };
          }
        } else if (inf.project) {
          emitLog(`slack project: low-confidence guess "${inf.project}" (${inf.confidence.toFixed(2)}) for ${channel} — asking instead`, 'Slack');
        }
      } catch { /* fall through to ask */ }
    }
  }

  // 5. Nothing confident — caller creates the task unlinked and asks in-thread.
  return { project: null, source: 'none' };
}

// Threads where NORC asked "which project?" and is waiting for the human's
// answer → the unlinked task to relink. In-memory + TTL: a project answer is a
// near-immediate follow-up; losing the pending marker across a restart just
// means the human re-states the project (or links it in Notion).
const pendingProjectAsk = new Map<string, { taskPageId: string; at: number }>();
const PENDING_PROJECT_TTL_MS = 60 * 60_000;

function pendingKey(channel: string, threadRoot: string): string {
  return `${channel}:${threadRoot}`;
}

const NO_PROJECT_REPLY =
  /\b(no project|none|nope|sans projet|aucun projet|pas de projet|leave it|unlinked|skip)\b/i;

/**
 * A thread reply answering NORC's "which project?" question. Relinks the
 * earlier unlinked task to the named project (updating Notion + the run rows so
 * completion summaries route to the project channel), or confirms it stays
 * unlinked. Returns true when it handled the turn; false (no pending ask, or the
 * reply doesn't name a project) lets the normal chat/task lanes take it.
 */
async function relinkProjectFromReply(args: {
  botToken: string;
  channel: string;
  threadRoot: string;
  request: string;
}): Promise<boolean> {
  const { botToken, channel, threadRoot, request } = args;
  const key = pendingKey(channel, threadRoot);
  const pending = pendingProjectAsk.get(key);
  if (!pending) return false;
  if (Date.now() - pending.at > PENDING_PROJECT_TTL_MS) { pendingProjectAsk.delete(key); return false; }

  const say = (text: string) =>
    postAsAgent(botToken, { channel, threadTs: threadRoot, agentName: 'NORC', text }).catch(() => undefined);

  // "no project" / "none" → stop asking, leave it unlinked.
  if (NO_PROJECT_REPLY.test(request)) {
    pendingProjectAsk.delete(key);
    await say('Got it — leaving this one with no project.');
    return true;
  }

  // Does the reply name a project? Try an explicit "project X", then the whole
  // reply (catches a bare name or "it's PGT v2.0"). No match → not an answer.
  const candidate = extractProjectMention(request) ?? request.trim();
  const project = candidate ? await findProjectByName(candidate) : null;
  if (!project) return false;

  pendingProjectAsk.delete(key);
  const integration = db.select().from(notionIntegration).all()[0];
  if (integration?.status === 'active') {
    await setTaskProject(integration.apiKey, pending.taskPageId, project.projectId).catch(() => undefined);
  }
  // Keep the run rows in step: projectId drives completion routing + serialization.
  db.update(taskRuns).set({ projectId: project.projectId })
    .where(eq(taskRuns.taskPageId, pending.taskPageId)).run();

  const url = `https://www.notion.so/${pending.taskPageId.replace(/-/g, '')}`;
  emitLog(`slack: relinked task to project "${project.block.name}" from thread reply`, 'Slack', pending.taskPageId);
  await say(`Linked <${url}|the task> to *${project.block.name}*.`);
  return true;
}

async function handleTaskAsk(args: {
  botToken: string;
  channel: string;
  threadRoot: string;
  target: AgentRef | null;
  request: string;
  asker: string;
  thread: SlackThreadLine[];
  title: string;
  kpis: string;
}): Promise<void> {
  const { botToken, channel, threadRoot, target, request, asker, thread, title, kpis } = args;
  const say = (text: string, agentName = 'NORC') =>
    postAsAgent(botToken, { channel, text, threadTs: threadRoot, agentName }).catch(() => undefined);

  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active') {
    await say('NORC has no active Notion workspace — connect Notion first, then ask again.');
    return;
  }
  const apiKey = integration.apiKey;
  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) {
    await say('The Notion workspace has no Tasks database — provision it from the dashboard first.');
    return;
  }

  // Resolve the project by the binding-first cascade (channel binding is the
  // source of truth; only an explicit "for project X" overrides it; an
  // unconfident result links nothing and we ASK below). See resolveSlackProject.
  const resolved = await resolveSlackProject({ botToken, channel, request, title, thread });
  const project = resolved.project;

  // Duplicate gate (same as the out-of-band intake): "create anyway" in a
  // follow-up forces past it.
  const force = /create anyway|force create/i.test(request);
  if (!force) {
    try {
      const open = await listOpenTasks(apiKey, tasksDb.notionDatabaseId, project?.projectId);
      const blocking = await findBlockingSimilar(title, request, open);
      if (blocking.length > 0) {
        const lines = blocking.slice(0, 3).map(b => `• <${b.url}|${b.title}> (${b.status}${b.assignedTo.length ? `, @${b.assignedTo.join(', @')}` : ''})`);
        await say(`This looks like existing work:\n${lines.join('\n')}\nReply with *create anyway* if it's genuinely new.`);
        return;
      }
    } catch { /* gate is best-effort */ }
  }

  // Create the task — request + the Slack conversation land in the body, so
  // the run's context assembly sees the full story.
  let pageId: string;
  let url: string;
  try {
    const created = await createTaskPage(apiKey, tasksDb.notionDatabaseId, {
      title,
      kpis,
      projectId: project?.projectId ?? null,
      assigneeIds: target ? [target.orgDbPageId] : [],
    });
    pageId = created.pageId;
    url = created.url;
  } catch (err) {
    await say(`Couldn't create the Notion task: ${err instanceof Error ? err.message : 'unknown error'}`);
    return;
  }
  const transcript = thread.length
    ? `\n\n**Slack conversation:**\n${thread.map(l => `- ${l.author}: ${l.text}`).join('\n')}`
    : '';
  const body = `${request}\n\n_Requested by ${asker} in Slack (channel ${channel})._${transcript}`;
  await appendBlocks(apiKey, pageId, markdownToBlocks(body)).catch(() => { /* best-effort */ });

  // The creation is handled HERE — webhooks for this page must not re-triage
  // or re-dispatch it (the claimExternalTask pre-marking pattern).
  markProcessed(`triage:${pageId}`);
  if (target) markProcessed(`page:${pageId}:${target.agentId}`);

  emitLog(`slack task created: "${title}"${target ? ` → @${target.name}` : ''}${project ? ` (project ${project.block.name}, via ${resolved.source})` : ' (no project)'}`, 'Slack', pageId);

  // Couldn't confidently resolve a project: the task runs unlinked, and we ask
  // the thread to name one (relinkProjectFromReply applies the answer).
  let askLine = '';
  if (resolved.source === 'none') {
    pendingProjectAsk.set(pendingKey(channel, threadRoot), { taskPageId: pageId, at: Date.now() });
    askLine = `\n_I couldn't match this to a project — reply with a project name to link it, or "no project" to leave it unlinked._`;
  }

  let anchor;
  try {
    anchor = await resolveAnchor(apiKey, pageId);
  } catch {
    await say(`Created <${url}|${title}> but couldn't re-read it to dispatch — assign it from Notion.`);
    return;
  }

  if (target) {
    await say(`Created <${url}|${title}>${project ? ` on *${project.block.name}*` : ''} — @${target.name} is on it. I'll report back here.${askLine}`);
    await requestAgentTurn(integration, anchor, target, {
      thread: [],
      request,
      triggeringUserId: null,
      lane: 'work',
      manageTaskStatus: true,
      how: 'slack request',
      slackChannel: channel,
      slackThreadTs: threadRoot,
    });
    return;
  }

  // No explicit agent: pick one via the triage LLM and dispatch with the
  // Slack origin attached, so the completion still reports into this thread.
  const routed = await routeViaTriage(botToken, channel, threadRoot, `${title} — ${request}`, thread);
  if (routed) {
    markProcessed(`page:${pageId}:${routed.agentId}`);
    await say(`Created <${url}|${title}>${project ? ` on *${project.block.name}*` : ''} — @${routed.name} is on it. I'll report back here.${askLine}`);
    await requestAgentTurn(integration, anchor, routed, {
      thread: [],
      request,
      triggeringUserId: null,
      lane: 'work',
      manageTaskStatus: true,
      how: 'slack request (triage-routed)',
      slackChannel: channel,
      slackThreadTs: threadRoot,
    });
    return;
  }
  // Triage already explained itself in the thread; the task waits in Backlog —
  // assigning an agent in Notion dispatches it normally.
  await say(`The task is parked at <${url}|${title}> — assign an agent there (or tag one here) to start it.${askLine}`);
}
