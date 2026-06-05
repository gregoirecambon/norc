// The NORC Orchestrator — a "co-CEO" LLM that triages events no agent was
// assigned to. PURE: it only calls the LLM and parses a decision; it performs no
// Notion writes (the orchestrator pipeline applies the decision). This keeps the
// reasoning unit-testable and avoids an import cycle with orchestrator.ts.

import { dispatch } from '../adapters/index.js';

export interface TriageCandidate {
  name: string;
  specialty: string;
  capabilities: string;
}

export interface TriageInput {
  apiKey: string;
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
  'You are the NORC Orchestrator, a co-CEO for a Notion workspace staffed by AI and human agents. ' +
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

  const res = await dispatch({ adapterType: 'claude-api', config: { apiKey: input.apiKey, model: input.model }, system, prompt });
  if (!res.ok || !res.text) {
    return { decision: 'ignore', agent: null, confidence: 0, message: res.error ?? 'no response' };
  }
  return parseDecision(res.text, input.candidates);
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
