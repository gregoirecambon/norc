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
  'When work arrives with nobody assigned, you decide who should handle it. Be decisive but honest: ' +
  'route only when an agent clearly fits, suggest when a human should confirm, and ignore when no ' +
  'agent is suitable or no action is needed. Prefer the most specialized fit.';

export async function triage(input: TriageInput): Promise<TriageDecision> {
  const system = input.systemPrompt?.trim() || DEFAULT_SYSTEM;
  const roster = input.candidates.length
    ? input.candidates
        .map(c => `- ${c.name}${c.specialty ? ` — ${c.specialty}` : ''}${c.capabilities ? ` [${c.capabilities}]` : ''}`)
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
    `- route: confident a specific agent should do this now.`,
    `- suggest: a likely agent, but a human should confirm.`,
    `- ignore: no suitable agent, or no agent action is needed.`,
    `In "message", address the user and write the agent as @name when routing or suggesting.`,
  ].join('\n');

  const res = input.provider === 'openai'
    ? await callOpenAICompatible(input.baseUrl ?? '', input.apiKey, input.model, system, prompt)
    : await dispatch({
        adapterType: 'claude-api',
        config: { apiKey: input.apiKey, model: input.model, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) },
        system, prompt,
      });
  if (!res.ok || !res.text) {
    return { decision: 'ignore', agent: null, confidence: 0, message: res.error ?? 'no response' };
  }
  return parseDecision(res.text, input.candidates);
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
