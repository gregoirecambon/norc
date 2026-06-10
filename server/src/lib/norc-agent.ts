// The NORC agent's own conversational turn — what runs when someone @mentions
// NORC or assigns it a task. PURE, like orchestrator-agent.ts: one LLM call
// returning a JSON decision { reply, actions[] } validated against a strict
// whitelist; the orchestrator executes the actions and posts the reply. No
// agentic tool loop, no Notion writes here, no orchestrator import (no cycle).

import { callTriageLLM, rosterBlock, type LLMConfig, type TriageCandidate } from './orchestrator-agent.js';

/** What NORC may change about itself — each kind maps to a specific setting or
 * its Org DB profile. Applied ONLY through the propose→approve flow. */
export const SELF_CHANGE_KINDS = [
  'orchestratorSystemPrompt',
  'autoRouteThreshold',
  'autoProposeEnabled',
  'autoProposeIntervalHours',
  'norcOrgPage',
] as const;
export type SelfChangeKind = (typeof SELF_CHANGE_KINDS)[number];

const NORC_TASK_STATUSES = ['Backlog', 'Done', 'Failed', 'Blocked', 'Draft'] as const;
export type NorcTaskStatus = (typeof NORC_TASK_STATUSES)[number];

export type NorcAction =
  | { type: 'assign_task'; taskPageId: string; assignee: string }
  | { type: 'triage_task'; taskPageId: string }
  | { type: 'set_task_status'; taskPageId: string; status: NorcTaskStatus }
  | { type: 'propose_tasks'; tasks: { title: string; description?: string; kpis?: string }[] }
  | { type: 'nudge_agent'; agentName: string; message: string }
  | { type: 'propose_self_change'; kind: SelfChangeKind; payload: Record<string, unknown>; rationale: string };

export interface NorcDecision {
  reply: string;
  actions: NorcAction[];
}

export interface NorcOpenTask {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

export interface NorcWorkspaceSnapshot {
  agents: TriageCandidate[];
  humans: { name: string; specialty: string }[];
  openTasks: NorcOpenTask[];
  activeRuns: number;
  queuedTurns: number;
  settings: {
    autoRouteThreshold: number;
    autoProposeEnabled: boolean;
    autoProposeIntervalHours: number;
    orchestratorSystemPrompt: string | null;
  };
}

export interface NorcTurnInput extends LLMConfig {
  /** Override for NORC's persona (norcSettings.orchestratorSystemPrompt). */
  systemPrompt?: string;
  request: string;
  conversation: string[];
  anchorKind: string;
  anchorTitle: string;
  workspace: NorcWorkspaceSnapshot;
}

const MAX_ACTIONS = 5;
const MAX_PROPOSED_TASKS = 10;

export const NORC_AGENT_SYSTEM =
  'You are NORC, the orchestrator of this Notion workspace — a team member people can @mention to ask ' +
  'questions, route work, and operate the task system. Answer from the WORKSPACE SNAPSHOT you are given; ' +
  'never invent agents, tasks, or state. You act ONLY through the listed action types — anything else is ' +
  'just words in your reply. Prefer AI agents for work; humans are a last resort. Any change to your own ' +
  'configuration or behavior MUST be a propose_self_change action: it takes effect only after a human ' +
  'replies "approve" in the thread, so never claim a self-change is already applied. Keep replies short, ' +
  'concrete, and friendly.';

/** Assemble the NORC turn prompt. Pure and exported for prompt-shape tests. */
export function buildNorcPrompt(input: NorcTurnInput): string {
  const ws = input.workspace;
  const agents = ws.agents.length ? ws.agents.map(rosterBlock).join('\n\n') : '(no agents registered)';
  const humans = ws.humans.length
    ? ws.humans.map(h => `- ${h.name}${h.specialty ? ` — ${h.specialty}` : ''}`).join('\n')
    : '(none)';
  const tasks = ws.openTasks.length
    ? ws.openTasks.map(t => `- [${t.id}] "${t.title}" (${t.status})${t.assignee ? ` — assigned to ${t.assignee}` : ''}`).join('\n')
    : '(no open tasks)';
  const convo = input.conversation.length
    ? `\nConversation so far:\n${input.conversation.map(l => `- ${l}`).join('\n')}\n`
    : '';

  return [
    `You (NORC) were addressed on a Notion ${input.anchorKind} page "${input.anchorTitle || '(untitled)'}".`,
    ``,
    `REQUEST:`,
    input.request || '(none — you were assigned this page; decide how to handle it)',
    convo,
    `WORKSPACE SNAPSHOT:`,
    ``,
    `AGENTS:`,
    agents,
    ``,
    `HUMAN TEAM MEMBERS (assignment last resort):`,
    humans,
    ``,
    `OPEN TASKS (bounded list):`,
    tasks,
    ``,
    `LOAD: ${ws.activeRuns} run(s) in flight, ${ws.queuedTurns} turn(s) queued.`,
    ``,
    `YOUR CURRENT CONFIGURATION:`,
    `- autoRouteThreshold: ${ws.settings.autoRouteThreshold}`,
    `- autoProposeEnabled: ${ws.settings.autoProposeEnabled} (every ${ws.settings.autoProposeIntervalHours}h)`,
    `- your system prompt: """${ws.settings.orchestratorSystemPrompt?.trim() || '(default — not customized)'}"""`,
    ``,
    `Respond with ONLY a JSON object, no prose or code fences:`,
    `{"reply":"<the message posted to the thread — always required>","actions":[<zero or more actions>]}`,
    `Allowed actions (at most ${MAX_ACTIONS}; use [] when the request only needs an answer):`,
    `- {"type":"assign_task","taskPageId":"<id from OPEN TASKS>","assignee":"<exact agent or human name>"} — assign and (for agents) dispatch now.`,
    `- {"type":"triage_task","taskPageId":"<id>"} — let the triage pipeline pick the best owner.`,
    `- {"type":"set_task_status","taskPageId":"<id>","status":"${NORC_TASK_STATUSES.join('"|"')}"} — drive a task's lifecycle.`,
    `- {"type":"propose_tasks","tasks":[{"title":"<imperative>","description":"<optional>","kpis":"<optional>"}]} — create new Backlog tasks.`,
    `- {"type":"nudge_agent","agentName":"<exact agent name>","message":"<what to ask/tell them>"} — send an agent a direct chat turn.`,
    `- {"type":"propose_self_change","kind":"${SELF_CHANGE_KINDS.join('"|"')}","payload":{...},"rationale":"<why>"} — propose a change to yourself (applied only after human approval).`,
    `propose_self_change payloads: orchestratorSystemPrompt {"value":"<the full new prompt>"}; autoRouteThreshold {"value":<0..1>}; autoProposeEnabled {"value":true|false}; autoProposeIntervalHours {"value":<1..24>}; norcOrgPage {"specialty":"<text>"} and/or {"systemPrompt":"<text>"} for your Org DB profile.`,
    `Rules: only reference task ids from OPEN TASKS and names from the rosters. Prefer agents; suggest humans only when no agent fits. When asked to change how YOU think/behave, emit propose_self_change with the COMPLETE new value (not a diff) and tell the user it awaits their approval.`,
  ].join('\n');
}

/** One LLM call → validated decision. Falls back to a plain reply on errors. */
export async function norcDecide(input: NorcTurnInput): Promise<NorcDecision> {
  const system = input.systemPrompt?.trim() || NORC_AGENT_SYSTEM;
  const res = await callTriageLLM(input, system, buildNorcPrompt(input));
  if (!res.ok || !res.text) {
    throw new Error(res.error ?? 'no response from the orchestrator LLM');
  }
  return parseNorcDecision(res.text);
}

/** Parse + whitelist-validate the decision JSON. Unknown/invalid actions are
 * dropped (never executed); garbage degrades to a reply with no actions. */
export function parseNorcDecision(text: string): NorcDecision {
  const obj = extractJson(text);
  if (!obj) {
    return { reply: text.trim().slice(0, 2000) || 'I had trouble forming a decision — please rephrase.', actions: [] };
  }
  const reply = typeof obj['reply'] === 'string' && obj['reply'].trim()
    ? obj['reply'].trim()
    : 'Done — see actions below.';
  const rawActions = Array.isArray(obj['actions']) ? obj['actions'] : [];
  const actions: NorcAction[] = [];
  for (const raw of rawActions) {
    if (actions.length >= MAX_ACTIONS) break;
    const a = validateAction(raw);
    if (a) actions.push(a);
  }
  return { reply, actions };
}

function validateAction(raw: unknown): NorcAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');

  switch (r['type']) {
    case 'assign_task': {
      const taskPageId = str('taskPageId'), assignee = str('assignee');
      return taskPageId && assignee ? { type: 'assign_task', taskPageId, assignee } : null;
    }
    case 'triage_task': {
      const taskPageId = str('taskPageId');
      return taskPageId ? { type: 'triage_task', taskPageId } : null;
    }
    case 'set_task_status': {
      const taskPageId = str('taskPageId');
      const status = str('status') as NorcTaskStatus;
      return taskPageId && (NORC_TASK_STATUSES as readonly string[]).includes(status)
        ? { type: 'set_task_status', taskPageId, status }
        : null;
    }
    case 'propose_tasks': {
      if (!Array.isArray(r['tasks'])) return null;
      const tasks = (r['tasks'] as unknown[])
        .slice(0, MAX_PROPOSED_TASKS)
        .map(t => {
          if (!t || typeof t !== 'object') return null;
          const tr = t as Record<string, unknown>;
          const title = typeof tr['title'] === 'string' ? tr['title'].trim() : '';
          if (!title) return null;
          return {
            title,
            ...(typeof tr['description'] === 'string' && tr['description'].trim() ? { description: tr['description'].trim() } : {}),
            ...(typeof tr['kpis'] === 'string' && tr['kpis'].trim() ? { kpis: tr['kpis'].trim() } : {}),
          };
        })
        .filter((t): t is { title: string; description?: string; kpis?: string } => t !== null);
      return tasks.length ? { type: 'propose_tasks', tasks } : null;
    }
    case 'nudge_agent': {
      const agentName = str('agentName'), message = str('message');
      return agentName && message ? { type: 'nudge_agent', agentName, message } : null;
    }
    case 'propose_self_change': {
      const kind = str('kind') as SelfChangeKind;
      if (!(SELF_CHANGE_KINDS as readonly string[]).includes(kind)) return null;
      const payload = r['payload'] && typeof r['payload'] === 'object' && !Array.isArray(r['payload'])
        ? r['payload'] as Record<string, unknown>
        : null;
      if (!payload) return null;
      return { type: 'propose_self_change', kind, payload, rationale: str('rationale') };
    }
    default:
      return null;
  }
}

/** Extract the first balanced-looking JSON object from arbitrary model output. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}
