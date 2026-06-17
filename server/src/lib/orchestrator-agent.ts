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
  /** 'human' members are last-resort, suggest-only candidates. Default: 'agent'. */
  kind?: 'agent' | 'human';
  specialty: string;
  capabilities: string;
  technology?: string;
  /** Short description from the agent's Org DB page body (caller-truncated). */
  description?: string;
  /** Other non-empty Org DB properties, already rendered to plain text. */
  properties?: Array<{ name: string; value: string }>;
  /** In-flight work runs right now. */
  activeRuns?: number;
  /** Turns waiting in the agent's dispatch queue. */
  queuedCount?: number;
  /** The agent's concurrent-run cap. */
  maxConcurrentRuns?: number;
}

/** Task-side evidence for the triage prompt (assembled by triage-context.ts). */
export interface TriageTaskContext {
  /** Task/page body excerpt (caller-truncated). */
  body?: string;
  status?: string;
  kpis?: string;
  projectName?: string;
  projectObjective?: string;
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
  taskContext?: TriageTaskContext;
  /** Machine-facing re-triage note, e.g. "agent X already timed out on this". */
  retriageNote?: string;
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
  'evidenced fit; "ignore" for noise, items needing no agent, or when no agent has the needed capability. ' +
  'Your confidence score is a calibration promise: above 0.5 means you can cite the exact roster evidence ' +
  'for the match; without citable evidence, stay below 0.5. Human team members may appear in the roster as ' +
  'a LAST RESORT: always prefer an AI agent; pick a human only when no agent plausibly fits, and then only ' +
  'ever "suggest" — never "route" — so a person confirms the assignment.';

/** One roster entry as a multi-line block. Empty key fields render explicitly as
 * "(none listed)" — load-bearing for calibration: a blank line would let the
 * model imagine capabilities the agent never claimed. */
export function rosterBlock(c: TriageCandidate): string {
  const lines = [
    `### ${c.name}`,
    `Specialty: ${c.specialty || '(none listed)'}`,
    `Capabilities: ${c.capabilities || '(none listed)'}`,
  ];
  if (c.technology) lines.push(`Technology: ${c.technology}`);
  for (const p of c.properties ?? []) lines.push(`${p.name}: ${p.value}`);
  lines.push(`About: ${c.description || '(no description)'}`);
  if (typeof c.activeRuns === 'number') {
    lines.push(`Load: ${c.activeRuns} running, ${c.queuedCount ?? 0} queued${typeof c.maxConcurrentRuns === 'number' ? ` / cap ${c.maxConcurrentRuns}` : ''}`);
  }
  return lines.join('\n');
}

/** Assemble the triage user prompt. Pure and exported so prompt-shape changes are
 * unit-testable without an LLM call. */
export function buildTriagePrompt(input: TriageInput): string {
  const agentCandidates = input.candidates.filter(c => c.kind !== 'human');
  const humanCandidates = input.candidates.filter(c => c.kind === 'human');
  const roster = agentCandidates.length
    ? agentCandidates.map(rosterBlock).join('\n\n')
    : '(no agents registered)';
  const humanRoster = humanCandidates.length
    ? ['', 'HUMAN TEAM MEMBERS (LAST RESORT ONLY):', humanCandidates.map(rosterBlock).join('\n\n')].join('\n')
    : '';
  const humanRules = humanCandidates.length
    ? [
        `Humans are a LAST RESORT: ALWAYS prefer an AI agent. Consider a human ONLY when no listed agent's capabilities plausibly cover this work.`,
        `A human can never be auto-routed: when your best fit is a human, the decision MUST be "suggest" (never "route"), with a message proposing the assignment for a person to confirm.`,
      ]
    : [];
  const commented = input.commentedText?.trim()
    ? `\n\nText being commented on:\n"""\n${input.commentedText.trim()}\n"""`
    : '';
  const convo = input.conversation && input.conversation.length
    ? `\n\nConversation so far:\n${input.conversation.map(l => `- ${l}`).join('\n')}`
    : '';
  const retriage = input.retriageNote?.trim()
    ? `\n\nRE-TRIAGE NOTE: ${input.retriageNote.trim()}`
    : '';

  let taskContext = '';
  const tc = input.taskContext;
  if (tc && (tc.body || tc.status || tc.kpis || tc.projectName || tc.projectObjective)) {
    const lines = ['', '', 'TASK CONTEXT:'];
    if (tc.status) lines.push(`Status: ${tc.status}`);
    if (tc.kpis) lines.push(`KPIs / success criteria: ${tc.kpis}`);
    if (tc.projectName || tc.projectObjective) {
      lines.push(`Project: ${tc.projectName || '(unnamed)'}${tc.projectObjective ? ` — Objective: ${tc.projectObjective}` : ''}`);
    }
    if (tc.body) lines.push(`Page content:`, `"""`, tc.body, `"""`);
    taskContext = lines.join('\n');
  }

  return [
    `A Notion ${input.kind} has no agent assigned and needs triage.`,
    `Title: ${input.title || '(untitled)'}`,
    `Content/request: ${input.text || '(none)'}`,
    commented,
    convo,
    retriage,
    taskContext,
    ``,
    `AVAILABLE AGENTS:`,
    roster,
    humanRoster,
    ``,
    `Respond with ONLY a JSON object, no prose or code fences:`,
    `{"decision":"route"|"suggest"|"ignore","agent":"<exact agent name from the list, or null>","confidence":<number 0..1>,"message":"<one short sentence shown to the user in Notion>"}`,
    `- route: a listed agent's capabilities clearly and confidently match — dispatch now.`,
    `- suggest: a listed agent likely fits, but a human should confirm.`,
    `- ignore: NO listed agent has the needed capability (ask the human), or no agent action is needed.`,
    ...humanRules,
    `Only pick an agent whose listed specialty/capabilities/technology actually cover this task. Do NOT guess or invent a fit, and never name an agent not in the list above.`,
    `Each agent shows its current load (running/queued/cap). When two candidates fit comparably, prefer the less-loaded one — work routed to a saturated agent waits in its queue. Capability fit always comes first.`,
    `In "message", address the user and write the agent as @name when routing or suggesting; when ignoring for lack of a fit, say so and ask who should take it.`,
    `Confidence calibration: confidence must reflect EVIDENCE, not instinct. Before choosing an agent, identify the specific Specialty/Capabilities/About line in the roster that covers this task, and cite it in "message" (e.g. "routing to @x because their capabilities include <y>"). If you cannot cite a concrete, specific match — for example the agent's fields say "(none listed)" or the task context is too thin to know what skills are needed — you MUST set confidence below 0.5 so a human confirms before any auto-route. An empty or generic roster entry is never evidence of a fit.`,
  ].join('\n');
}

export async function triage(input: TriageInput): Promise<TriageDecision> {
  const system = input.systemPrompt?.trim() || DEFAULT_SYSTEM;
  const prompt = buildTriagePrompt(input);

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

// ─── Rolling memos: the cost-bounding incremental summaries ───────────────────
// A cheap model folds each cycle's bounded signals into a capped rolling memo, so
// the context handed to the proposal step stays ~constant as the workspace grows.

export interface SummarizeMemoInput extends LLMConfig {
  /** The previous rolling memo ('' on the first cycle). */
  prevMemo: string;
  /** This cycle's bounded signals digest. */
  signals: string;
  /** Hard char cap for the returned memo. */
  maxChars: number;
  /** 'project' = one app's slice; 'global' = cross-portfolio executive memo. */
  scope: 'project' | 'global';
  /** Subject label (e.g. the project name) for the prompt. */
  label?: string;
}

const PROJECT_MEMO_SYSTEM =
  'You maintain a concise rolling memo for ONE project/app in a company portfolio. Given the PREVIOUS ' +
  'memo and the LATEST signals (recent completions, agent outputs, routine health, KPIs, and any ' +
  'progress note from the team), produce an UPDATED memo capturing: the trend, what is working, what ' +
  'is stuck/blocked, and a qualitative read on KPI progress. Be terse and evidence-grounded; drop ' +
  'stale detail to fit the length limit. Output ONLY the memo text — no preamble, no JSON.';

const GLOBAL_MEMO_SYSTEM =
  'You maintain a concise cross-portfolio executive memo for a company running many apps. Given the ' +
  'PREVIOUS memo and the LATEST per-project headlines, produce an UPDATED memo capturing company-wide ' +
  'themes: which apps have momentum, which are stuck, portfolio-level risks and opportunities, and ' +
  'where leverage is highest right now. Be terse and evidence-grounded; drop stale detail to fit the ' +
  'length limit. Output ONLY the memo text — no preamble, no JSON.';

/** Incrementally update a rolling memo with a (cheap) model. SAFE DEFAULT:
 *  returns prevMemo unchanged when the LLM is unavailable/empty — never wipes a
 *  good memo. The result is hard-capped to maxChars. */
export async function summarizeMemo(input: SummarizeMemoInput): Promise<string> {
  const system = input.scope === 'global' ? GLOBAL_MEMO_SYSTEM : PROJECT_MEMO_SYSTEM;
  const prompt = [
    input.label ? `Subject: ${input.label}` : '',
    `PREVIOUS MEMO (carry forward what's still true; revise what changed):`,
    input.prevMemo.trim() || '(none yet — this is the first cycle)',
    ``,
    `LATEST SIGNALS this cycle:`,
    input.signals.trim() || '(no new signals)',
    ``,
    `Write the updated memo in at most ${input.maxChars} characters. Output ONLY the memo text.`,
  ].filter(l => l !== '').join('\n');
  const res = await callTriageLLM(input, system, prompt);
  if (!res.ok || !res.text) return input.prevMemo;
  const memo = res.text.trim();
  return memo ? memo.slice(0, input.maxChars) : input.prevMemo;
}

// ─── Business proposals: the recurring co-CEO analysis ───────────────────────

export interface ProposeBizInput extends LLMConfig {
  /** Cross-portfolio rolling executive memo. */
  globalMemo: string;
  /** Bounded per-project memos + fresh signals (already budget-truncated by the caller). */
  projectContext: string;
  /** Compact projects + KPIs digest. */
  kpis: string;
  /** Standing routines/habits already scheduled. */
  routines: string;
  /** Open-work titles — dedup + load sense. */
  existingTitles: string[];
  max: number;
  /** Permit recurring-routine proposals (not just one-shots). */
  allowRoutines: boolean;
}

export type ProposedBizTask = {
  title: string;
  rationale?: string;
  kpis?: string;
  /** Set when the co-CEO proposes a recurring routine. */
  recurrence?: string;
  repeatEveryDays?: number;
  scheduledFor?: string;
};

/** Recurrence presets the scheduler understands (must match notion-provision). */
const RECURRENCE_VALUES = new Set(['Daily', 'Weekdays', 'Weekly', 'Monthly']);

const PROPOSE_SYSTEM =
  'You are NORC, the co-CEO of this company. You are given a rolling executive memo, per-project state ' +
  '(with qualitative KPI progress), the current KPIs/objectives, the standing routines, and the list of ' +
  'open work. Think like a CEO: from the EVIDENCE provided, propose a few NEW, concrete, high-leverage ' +
  'actions that will move KPIs and grow revenue now — closing gaps, doubling down on what is working, and ' +
  'unblocking what is stuck. You may propose one-shot tasks AND recurring routines/habits (e.g. a weekly ' +
  'retro, a monthly KPI review). Be specific and actionable, ground each in the evidence, and never ' +
  'duplicate existing open work. If nothing is worth proposing, return an empty array.';

/** Propose business actions from the co-CEO's memos + fresh signals. Safe default: [] (no proposals). */
export async function proposeBusinessTasks(input: ProposeBizInput): Promise<ProposedBizTask[]> {
  const existing = input.existingTitles.length ? input.existingTitles.map(t => `- ${t}`).join('\n') : '(none)';
  const schema = input.allowRoutines
    ? `[{"title":"<short imperative>","rationale":"<why it matters now, citing the evidence>","kpis":"<success criteria or empty>","recurrence":"<None|Daily|Weekdays|Weekly|Monthly>","repeatEveryDays":<number, or omit>,"scheduledFor":"<YYYY-MM-DD for a routine's first run, or omit>"}]`
    : `[{"title":"<short imperative>","rationale":"<why it matters now>","kpis":"<success criteria or empty>"}]`;
  const prompt = [
    `EXECUTIVE MEMO (cross-portfolio):`,
    input.globalMemo.trim() || '(none yet)',
    ``,
    `PER-PROJECT STATE & RECENT SIGNALS:`,
    input.projectContext.trim() || '(none)',
    ``,
    `PROJECTS & KPIs:`,
    input.kpis.trim() || '(none)',
    ``,
    `STANDING ROUTINES (habits already scheduled):`,
    input.routines.trim() || '(none)',
    ``,
    `EXISTING OPEN WORK — do NOT duplicate these:`,
    existing,
    ``,
    input.allowRoutines
      ? `Propose at most ${input.max} new actions; each may be a one-shot OR a recurring routine. Respond with ONLY a JSON array, no prose:`
      : `Propose at most ${input.max} new one-shot tasks. Respond with ONLY a JSON array, no prose:`,
    schema,
  ].join('\n');
  const res = await callTriageLLM(input, PROPOSE_SYSTEM, prompt);
  if (!res.ok || !res.text) return [];
  return parseBusinessTasks(res.text).slice(0, Math.max(1, input.max));
}

/** Parse a JSON array of proposed tasks; anything unparseable → []. Routine fields
 * are validated defensively — an invalid recurrence/cadence is dropped (the entry
 * stays a one-shot) rather than written as a malformed Notion property. */
export function parseBusinessTasks(text: string): ProposedBizTask[] {
  const arr = extractJsonArray(text);
  if (!arr) return [];
  const out: ProposedBizTask[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
    if (!title) continue;
    const recurrence = typeof r['recurrence'] === 'string' && RECURRENCE_VALUES.has(r['recurrence']) ? r['recurrence'] : undefined;
    const repeatRaw = typeof r['repeatEveryDays'] === 'number' ? r['repeatEveryDays'] : NaN;
    const repeatEveryDays = Number.isFinite(repeatRaw) && repeatRaw > 0 ? Math.floor(repeatRaw) : undefined;
    const scheduledFor = typeof r['scheduledFor'] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r['scheduledFor'].trim()) ? r['scheduledFor'].trim() : undefined;
    out.push({
      title,
      ...(typeof r['rationale'] === 'string' ? { rationale: r['rationale'] } : {}),
      ...(typeof r['kpis'] === 'string' ? { kpis: r['kpis'] } : {}),
      // Routine fields only when a real recurrence/cadence is present.
      ...(recurrence ? { recurrence } : {}),
      ...(repeatEveryDays !== undefined ? { repeatEveryDays } : {}),
      ...((recurrence || repeatEveryDays !== undefined) && scheduledFor ? { scheduledFor } : {}),
    });
  }
  return out;
}

// ─── Task-worthiness: is an off-task request real work or just a question? ────

export interface ClassifyInput extends LLMConfig {
  kind: string;
  title: string;
  text: string;
  conversation?: string[];
  /** Known project names — lets the classifier pin "for project X" mentions. */
  projects?: string[];
}

export type TaskWorthy = { task: boolean; title?: string; kpis?: string; project?: string };

const CLASSIFY_SYSTEM =
  'You decide whether a Notion comment/request is a trackable piece of WORK (something to DO that deserves ' +
  'a task) versus just a question, discussion, or feedback. Be conservative: task=true only for clear, ' +
  'actionable work.';

/** Classify an off-task request as task-worthy (with a suggested title). Safe
 * default: task=false (don't create spurious tasks if the LLM is unavailable). */
export async function classifyTaskWorthy(input: ClassifyInput): Promise<TaskWorthy> {
  const convo = input.conversation?.length ? `\nConversation:\n${input.conversation.map(l => `- ${l}`).join('\n')}` : '';
  const projectList = input.projects?.length ? `\nKnown projects: ${input.projects.join(', ')}` : '';
  const projectField = input.projects?.length
    ? `,"project":"<the project the request names, copied EXACTLY from the known list — empty if none is named>"`
    : '';
  const prompt = [
    `Surface: ${input.kind} page "${input.title || '(untitled)'}"`,
    `Request/comment: ${input.text || '(none)'}${convo}${projectList}`,
    ``,
    `Is this a trackable task (actionable work to do), or just a question/feedback?`,
    `Respond with ONLY JSON, no prose:`,
    `{"task":true|false,"title":"<short imperative task title>","kpis":"<success criteria or empty>"${projectField}}`,
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
  const project = typeof obj['project'] === 'string' && obj['project'].trim() ? obj['project'].trim() : undefined;
  return { task, ...(title ? { title } : {}), ...(kpis ? { kpis } : {}), ...(project ? { project } : {}) };
}

// ─── Project inference: which project does this work belong to? ───────────────
// The LAST resort in the Slack project-resolution cascade (after the channel
// binding and the channel-name match): a calibrated guess from the request +
// conversation, used ONLY when confidence clears a high bar so a soft topical
// overlap never silently mis-assigns work to the wrong project.

export interface InferProjectInput extends LLMConfig {
  title: string;
  text: string;
  conversation?: string[];
  /** The originating Slack channel's human name, when known (a strong cue). */
  channelName?: string | null;
  /** Candidate project names — the model must pick EXACTLY one or null. */
  projects: string[];
}

export type ProjectInference = { project: string | null; confidence: number };

const INFER_PROJECT_SYSTEM =
  'You map an incoming work request to the SINGLE project it belongs to, chosen from a fixed list. ' +
  'Decide ONLY from concrete evidence: a product/app/feature name in the request or conversation, the ' +
  'Slack channel name, or an explicit project mention. Do NOT guess from vague topical overlap. Your ' +
  'confidence is a calibration promise: use 0.9 or above ONLY when the evidence names the project ' +
  'unmistakably (you can point to the exact word); under any genuine doubt, stay well below 0.9. If no ' +
  'project clearly fits, return project null. Never invent a name that is not in the list.';

/** Infer the project for a piece of work, with a calibrated confidence. Safe
 * default: {project:null, confidence:0} when the LLM is unavailable/unparseable
 * or no candidates exist — the caller then asks a human. */
export async function inferProjectForTask(input: InferProjectInput): Promise<ProjectInference> {
  if (!input.projects.length) return { project: null, confidence: 0 };
  const convo = input.conversation?.length
    ? `\nConversation:\n${input.conversation.map(l => `- ${l}`).join('\n')}`
    : '';
  const prompt = [
    `Slack channel: ${input.channelName ? `#${input.channelName}` : '(name unknown)'}`,
    `Request: ${input.text || '(none)'}`,
    `Title: ${input.title || '(untitled)'}${convo}`,
    `Known projects (choose EXACTLY one of these names, or null): ${input.projects.join(', ')}`,
    ``,
    `Which project does this work belong to? Respond with ONLY JSON, no prose:`,
    `{"project":"<exact name from the list, or null>","confidence":<number 0..1>}`,
  ].join('\n');
  const res = await callTriageLLM(input, INFER_PROJECT_SYSTEM, prompt);
  if (!res.ok || !res.text) return { project: null, confidence: 0 };
  return parseProjectInference(res.text);
}

/** Parse the project-inference JSON; anything unparseable → no project. */
export function parseProjectInference(text: string): ProjectInference {
  const obj = extractJson(text);
  if (!obj) return { project: null, confidence: 0 };
  const raw = typeof obj['project'] === 'string' ? obj['project'].trim() : '';
  const project = raw && raw.toLowerCase() !== 'null' ? raw : null;
  const confidence = typeof obj['confidence'] === 'number' ? Math.max(0, Math.min(1, obj['confidence'])) : 0;
  return { project, confidence };
}

// ─── Duplicate-task judge: is an out-of-band request the SAME work as an open task? ───

export interface JudgeSimilarityInput extends LLMConfig {
  title: string;
  description?: string;
  candidates: { title: string; status: string }[];
}

export type SimilarityVerdict = { index: number; reason: string };

const JUDGE_SYSTEM =
  'You judge whether a NEW task duplicates EXISTING open tasks in a company workspace. "Same work" means ' +
  'doing it would make the existing task redundant (rephrasings, translations, and subsets/supersets of the ' +
  'same deliverable count). Related-but-distinct work does NOT count. Be precise — a false "same" blocks ' +
  'real work, a false "different" creates a duplicate.';

/**
 * Ask the triage LLM which candidates are the SAME work as the new task.
 * Returns null when the LLM is unavailable/unparseable so the caller can fall
 * back to the heuristic verdict (never silently "no duplicates").
 */
export async function judgeTaskSimilarity(input: JudgeSimilarityInput): Promise<SimilarityVerdict[] | null> {
  if (input.candidates.length === 0) return [];
  const list = input.candidates.map((c, i) => `${i}. "${c.title}" (status: ${c.status})`).join('\n');
  const prompt = [
    `New task: "${input.title}"`,
    input.description?.trim() ? `Details: ${input.description.trim().slice(0, 1000)}` : '',
    ``,
    `Existing open tasks on the same project:`,
    list,
    ``,
    `Which existing tasks are the SAME work as the new task (doing the new task would duplicate them)?`,
    `Respond with ONLY a JSON array, no prose — empty array if none:`,
    `[{"index":<number from the list>,"reason":"<one short sentence>"}]`,
  ].filter(l => l !== '').join('\n');
  const res = await callTriageLLM(input, JUDGE_SYSTEM, prompt);
  if (!res.ok || !res.text) return null;
  return parseSimilarityVerdicts(res.text, input.candidates.length);
}

/** Parse the judge's JSON array; null when unparseable (caller falls back). */
export function parseSimilarityVerdicts(text: string, candidateCount: number): SimilarityVerdict[] | null {
  const arr = extractJsonArray(text);
  if (!arr) return null;
  const out: SimilarityVerdict[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const index = typeof r['index'] === 'number' ? r['index'] : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue;
    out.push({ index, reason: typeof r['reason'] === 'string' ? r['reason'] : '' });
  }
  return out;
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
    ? input.candidates.map(c => `- ${c.name}${c.specialty ? ` — ${c.specialty}` : ''}${c.capabilities ? ` [${c.capabilities}]` : ''}${c.description ? ` — ${c.description}` : ''}`).join('\n')
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

// ─── Resource assist: NORC answers a stuck agent's lookup from workspace pages ───

export interface AssistSource { title: string; pageId: string; url?: string | null; body: string }

export interface AssistInput extends LLMConfig {
  question: string;
  sources: AssistSource[];
}

const ASSIST_SYSTEM =
  'You are NORC, the orchestrator for a Notion workspace, helping another AI agent that got stuck finding a ' +
  'resource. You are given the agent\'s question plus the full text of the most relevant workspace pages. ' +
  'Answer the question directly and concisely from those pages, citing each page by its title. If the pages ' +
  'do not contain the answer, say so plainly — never invent.';

/**
 * Answer a stuck agent's resource question from candidate workspace pages.
 * Returns '' when the LLM is unavailable/unparseable so the caller can fall back
 * to handing the agent the raw candidate list.
 */
export async function assist(input: AssistInput): Promise<{ answer: string }> {
  const sources = input.sources.length
    ? input.sources.map((s, i) => `### Source ${i + 1}: ${s.title || '(untitled)'} (pageId: ${s.pageId})\n${s.body.slice(0, 4000)}`).join('\n\n')
    : '(no candidate pages found)';
  const prompt = [
    `An agent asks: ${input.question}`,
    ``,
    `Relevant workspace pages:`,
    sources,
    ``,
    `Answer the question from these pages, citing page titles. If they don't contain the answer, say so.`,
  ].join('\n');
  const res = await callTriageLLM(input, ASSIST_SYSTEM, prompt);
  return { answer: res.ok && res.text ? res.text.trim() : '' };
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

  let matched: TriageCandidate | undefined;
  if (rawAgent) {
    const norm = rawAgent.replace(/^@/, '').trim().toLowerCase();
    matched = candidates.find(c => c.name.toLowerCase() === norm);
  }
  const agent = matched?.name ?? null;

  if (obj['decision'] === 'route' && agent) {
    // Hard guarantee, independent of the prompt: a human is never auto-routed —
    // a "route" verdict on a human candidate downgrades to a suggestion.
    if (matched?.kind === 'human') return { decision: 'suggest', agent, confidence, message };
    return { decision: 'route', agent, confidence, message };
  }
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

/** Extract the first JSON array from arbitrary model output. */
function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try { const v = JSON.parse(text.slice(start, end + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
}
