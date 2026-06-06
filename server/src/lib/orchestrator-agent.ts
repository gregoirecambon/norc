// The NORC Triage Agent — a "co-CEO" LLM that triages events no agent was
// assigned to. PURE: it only calls the LLM and parses a decision; it performs no
// Notion writes (the orchestrator pipeline applies the decision). This keeps the
// reasoning unit-testable and avoids an import cycle with orchestrator.ts.
//
// Provider is configurable: 'anthropic' (the claude-api adapter) or 'openai' (any
// OpenAI-compatible chat/completions endpoint, e.g. a LiteLLM proxy).

import { dispatch } from '../adapters/index.js';

export type TriageProvider = 'anthropic' | 'openai';

export interface TriageCandidate {
  name: string;
  specialty: string;
  capabilities: string;
  technology?: string;
}

export interface TriageInput {
  provider: TriageProvider;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  systemPrompt?: string;
  kind: string;
  title: string;
  text: string;
  commentedText?: string;
  conversation?: string[];
  candidates: TriageCandidate[];
}

export type TriageDecision =
  | { decision: 'route'; agent: string; confidence: number; message: string }
  | { decision: 'suggest'; agent: string | null; confidence: number; message: string }
  | { decision: 'ignore'; agent: null; confidence: number; message: string };

const DEFAULT_SYSTEM =
  'You are the NORC Triage Agent, a co-CEO for a Notion workspace staffed by AI and human agents. ' +
  'When work arrives with nobody assigned, you decide who should handle it — but ONLY on evidence. ' +
  'You may only choose "route" or "suggest" when a candidate\'s specialty/capabilities/technology in the ' +
  'roster CONCRETELY match the task. If no candidate clearly has the capability for this work, you MUST NOT ' +
  'guess or invent a fit: use "ignore" and ASK the human who should take it. Never name an agent that is not ' +
  'in the roster. ALWAYS write a clear, friendly `message` to the team: when routing, name the agent and ' +
  'explain WHY their listed capabilities fit; when unsure, say no listed agent clearly matches and ask who ' +
  'should take it. Prefer "suggest" (human confirms) under any doubt; "route" only for an obvious, confident, ' +
  'evidenced fit; "ignore" for noise, items needing no agent, or when no agent has the needed capability.';

export async function triage(input: TriageInput): Promise<TriageDecision> {
  const system = input.systemPrompt?.trim() || DEFAULT_SYSTEM;
  const roster = input.candidates.length
    ? input.candidates
        .map(c => `- ${c.name}${c.specialty ? ` — ${c.specialty}` : ''}${c.technology ? ` (tech: ${c.technology})` : ''}${c.capabilities ? ` [${c.capabilities}]` : ''}`)
        .join('\n')
    : '(no agents registered)';
  const commented = input.commentedText?.trim()
    ? `\n\nText being commented on:\n"""\n${input.commentedText.trim()}\n"""`
    : '';
  const convo = input.conversation && input.conversation.length
    ? `\n\nConversation so far:\n${input.conversation.map(l => `- ${l}`).join('\n')}`
    : '';

  const prompt = [
    `A Notion ${input.kind} has no agent assigned and needs triage.`,
    `Title: ${input.title || '(untitled)'}`,
    `Content/request: ${input.text || '(none)'}`,
    commented,
    convo,
    ``,
    `Available agents:`,
    roster,
    ``,
    `Respond with ONLY a JSON object, no prose or code fences:`,
    `{"decision":"route"|"suggest"|"ignore","agent":"<exact agent name from the list, or null>","confidence":<number 0..1>,"message":"<one short sentence shown to the user in Notion>"}`,
    `- route: a listed agent's capabilities clearly and confidently match — dispatch now.`,
    `- suggest: a listed agent likely fits, but a human should confirm.`,
    `- ignore: NO listed agent has the needed capability (ask the human), or no agent action is needed.`,
    `Only pick an agent whose listed specialty/capabilities/technology actually cover this task. Do NOT guess or invent a fit, and never name an agent not in the list above.`,
    `In "message", address the user and write the agent as @name when routing or suggesting; when ignoring for lack of a fit, say so and ask who should take it.`,
  ].join('\n');

  const res = await callTriageLLM(input, system, prompt);
  if (!res.ok || !res.text) {
    return { decision: 'ignore', agent: null, confidence: 0, message: res.error ?? 'no response' };
  }
  return parseDecision(res.text, input.candidates);
}

export interface LLMConfig {
  provider: TriageProvider;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
}

/** One provider-agnostic LLM call → { ok, text?, error? }. */
export async function callTriageLLM(cfg: LLMConfig, system: string, prompt: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (cfg.provider === 'openai') {
    return callOpenAICompatible(cfg.baseUrl ?? '', cfg.apiKey, cfg.model, system, prompt);
  }
  return dispatch({
    adapterType: 'claude-api',
    config: { apiKey: cfg.apiKey, model: cfg.model, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) },
    system, prompt,
  });
}

/** A lightweight connectivity check: ask the model to echo a token. */
export async function testTriageConnection(cfg: LLMConfig): Promise<{ ok: boolean; text?: string; error?: string }> {
  return callTriageLLM(cfg, 'You are a connectivity check for NORC.', 'Reply with the single word: OK');
}

// ─── Task-worthiness: is an off-task request real work or just a question? ────

export interface ClassifyInput extends LLMConfig {
  kind: string;
  title: string;
  text: string;
  conversation?: string[];
}

export type TaskWorthy = { task: boolean; title?: string; kpis?: string };

const CLASSIFY_SYSTEM =
  'You decide whether a Notion comment/request is a trackable piece of WORK (something to DO that deserves ' +
  'a task) versus just a question, discussion, or feedback. Be conservative: task=true only for clear, ' +
  'actionable work.';

/** Classify an off-task request as task-worthy (with a suggested title). Safe
 * default: task=false (don't create spurious tasks if the LLM is unavailable). */
export async function classifyTaskWorthy(input: ClassifyInput): Promise<TaskWorthy> {
  const convo = input.conversation?.length ? `\nConversation:\n${input.conversation.map(l => `- ${l}`).join('\n')}` : '';
  const prompt = [
    `Surface: ${input.kind} page "${input.title || '(untitled)'}"`,
    `Request/comment: ${input.text || '(none)'}${convo}`,
    ``,
    `Is this a trackable task (actionable work to do), or just a question/feedback?`,
    `Respond with ONLY JSON, no prose:`,
    `{"task":true|false,"title":"<short imperative task title>","kpis":"<success criteria or empty>"}`,
  ].join('\n');
  const res = await callTriageLLM(input, CLASSIFY_SYSTEM, prompt);
  if (!res.ok || !res.text) return { task: false };
  return parseTaskWorthy(res.text);
}

/** Parse the task-worthiness JSON; anything unparseable → not a task. */
export function parseTaskWorthy(text: string): TaskWorthy {
  const obj = extractJson(text);
  if (!obj) return { task: false };
  const task = obj['task'] === true;
  const title = typeof obj['title'] === 'string' ? obj['title'] : undefined;
  const kpis = typeof obj['kpis'] === 'string' ? obj['kpis'] : undefined;
  return { task, ...(title ? { title } : {}), ...(kpis ? { kpis } : {}) };
}

// ─── Outcome assessment: did the agent do the task, or is it blocked? ─────────

export interface AssessInput extends LLMConfig {
  task: string;
  agentName: string;
  reply: string;
  candidates: TriageCandidate[];
}

export type AssessResult = { outcome: 'completed' | 'blocked'; need?: string; message?: string };

const ASSESS_SYSTEM =
  'You judge whether an AI agent actually completed a task from its reply. "completed" = it did the work ' +
  '(answer, result, or a clear done). "blocked" = it could not or would not (asking for missing info, ' +
  'refusing, erroring, saying it lacks access/skills/context). When blocked, briefly say what it needs.';

/** Classify an agent's reply as completed vs blocked (safe default: completed, to
 * avoid re-route loops if the LLM is unavailable). */
export async function assessOutcome(input: AssessInput): Promise<AssessResult> {
  const roster = input.candidates.length
    ? input.candidates.map(c => `- ${c.name}${c.specialty ? ` — ${c.specialty}` : ''}${c.capabilities ? ` [${c.capabilities}]` : ''}`).join('\n')
    : '(no other agents)';
  const prompt = [
    `Agent "${input.agentName}" was asked to do a task and replied below.`,
    `Task: ${input.task || '(untitled)'}`,
    `Agent reply:`, `"""`, input.reply.slice(0, 2000), `"""`,
    ``,
    `Other available agents:`, roster,
    ``,
    `Did the agent COMPLETE the task, or is it BLOCKED (couldn't/wouldn't — needs info, access, a skill, or another agent)?`,
    `Respond with ONLY JSON, no prose:`,
    `{"outcome":"completed"|"blocked","need":"<what it needs / who could help, or empty>","message":"<one short sentence>"}`,
  ].join('\n');
  const res = await callTriageLLM(input, ASSESS_SYSTEM, prompt);
  if (!res.ok || !res.text) return { outcome: 'completed' };
  return parseAssessment(res.text);
}

/** Parse the assessment JSON; anything but an explicit "blocked" → completed. */
export function parseAssessment(text: string): AssessResult {
  const obj = extractJson(text);
  if (!obj) return { outcome: 'completed' };
  const outcome = obj['outcome'] === 'blocked' ? 'blocked' : 'completed';
  const need = typeof obj['need'] === 'string' ? obj['need'] : undefined;
  const message = typeof obj['message'] === 'string' ? obj['message'] : undefined;
  return { outcome, ...(need ? { need } : {}), ...(message ? { message } : {}) };
}

/**
 * Call an OpenAI-compatible chat/completions endpoint (OpenAI, or a LiteLLM
 * proxy). The base URL is the proxy root or an `…/v1` URL; see openaiEndpoint.
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!baseUrl.trim()) return { ok: false, error: 'orchestratorBaseUrl is required for the openai provider' };
  try {
    const res = await fetch(openaiEndpoint(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: `OpenAI HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const body = await res.json().catch(() => null) as unknown;
    const text = extractChatText(body);
    return text ? { ok: true, text } : { ok: false, error: 'empty completion' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'request failed' };
  }
}

/** Normalize a base URL to a chat/completions endpoint. Accepts a full endpoint,
 * an `…/v1` base (→ `…/v1/chat/completions`), or a bare host (→ `…/v1/chat/completions`). */
export function openaiEndpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function extractChatText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const choices = (body as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown> | null;
  const message = first && typeof first === 'object' ? first['message'] as Record<string, unknown> | undefined : undefined;
  const content = message?.['content'];
  return typeof content === 'string' ? content : '';
}

/** Parse the LLM's JSON decision; validate the agent against the roster. */
export function parseDecision(text: string, candidates: TriageCandidate[]): TriageDecision {
  const obj = extractJson(text);
  if (!obj) return { decision: 'ignore', agent: null, confidence: 0, message: '' };

  const confidence = typeof obj['confidence'] === 'number' ? Math.max(0, Math.min(1, obj['confidence'] as number)) : 0;
  const message = typeof obj['message'] === 'string' ? obj['message'] : '';
  const rawAgent = typeof obj['agent'] === 'string' ? obj['agent'] : null;

  let agent: string | null = null;
  if (rawAgent) {
    const norm = rawAgent.replace(/^@/, '').trim().toLowerCase();
    agent = candidates.find(c => c.name.toLowerCase() === norm)?.name ?? null;
  }

  if (obj['decision'] === 'route' && agent) return { decision: 'route', agent, confidence, message };
  if (obj['decision'] === 'suggest') return { decision: 'suggest', agent, confidence, message };
  return { decision: 'ignore', agent: null, confidence, message };
}

/** Extract the first balanced-looking JSON object from arbitrary model output. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}
