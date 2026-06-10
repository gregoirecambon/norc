// Out-of-band task intake — the "Slack rule". An agent that gets asked to do
// project work OUTSIDE NORC (Slack, chat, email…) must route it through here:
// check for a similar open task on the same project, then create-or-claim one
// and work it as a tracked run. The duplicate check lives server-side IN the
// create path (refused with 'similar' unless force) so the rule cannot be
// skipped by a forgetful agent. Authenticated by agentSecret (routes/me.ts).

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration, notionDatabases } from '../db/schema.js';
import { notionQuery } from './notion-client.js';
import { getTitle, getSelect, getRelationIds } from './notion-props.js';
import { createTaskPage, appendBlocks } from './notion-writeback.js';
import { markdownToBlocks } from './notion-blocks-md.js';
import { resolveAnchor } from './notion-anchor.js';
import { getNorcSettings } from './norc-settings.js';
import { judgeTaskSimilarity } from './orchestrator-agent.js';
import { heuristicCandidates, titleSimilarity } from './task-similarity.js';
import { claimExternalTask, type ExternalClaim } from './orchestrator.js';
import { createSemaphore } from './semaphore.js';
import { emitLog } from './logger.js';

type AgentRow = typeof agents.$inferSelect;
type Integration = typeof notionIntegration.$inferSelect;

/** Open = anything not terminal — these are the duplicate-check candidates. */
const OPEN_STATUSES = ['Draft', 'Backlog', 'Queued', 'In Progress', 'Proposed'];

/** Statuses an agent may claim out-of-band. In Progress is someone else's run;
 * Done/Failed are closed. Inert statuses (Draft/Proposed/empty) ARE claimable —
 * the human's out-of-band ask is exactly the validation they were waiting for. */
const CLAIMABLE_STATUSES = new Set(['', 'Draft', 'Backlog', 'Queued', 'Proposed']);

const MAX_OPEN_TASKS = 300; // pagination cap for the candidate pool

// One intake at a time: two simultaneous similar requests must not BOTH pass
// the duplicate check before either creates its task.
const intakeSemaphore = createSemaphore(1);

export interface OpenTask {
  id: string;
  title: string;
  status: string;
  url: string;
  assignedTo: string[];
}

export interface SimilarHit extends OpenTask {
  score: number;
  reason?: string;
}

export interface ProjectRef { id: string; name: string }

export type ListOutcome =
  | { outcome: 'not_active' }
  | { outcome: 'no_tasks_db' }
  | { outcome: 'project_not_found'; projects: ProjectRef[] }
  | { outcome: 'ok'; project: ProjectRef | null; tasks: (OpenTask & { score?: number })[] };

export type IntakeOutcome =
  | { outcome: 'not_active' }
  | { outcome: 'no_tasks_db' }
  | { outcome: 'agent_not_in_org' }
  | { outcome: 'title_required' }
  | { outcome: 'project_not_found'; projects: ProjectRef[] }
  | { outcome: 'task_not_found' }
  | { outcome: 'not_a_task' }
  | { outcome: 'task_closed'; status: string }
  | { outcome: 'task_already_active'; assignedTo: string[] }
  | { outcome: 'similar'; candidates: SimilarHit[] }
  | { outcome: 'created' | 'claimed'; task: { id: string; title: string; url: string }; claim: ExternalClaim };

export interface IntakeInput {
  title?: string;
  description?: string;
  kpis?: string;
  /** Project page id (dashed or bare) or project name. */
  project?: string;
  force?: boolean;
  existingTaskPageId?: string;
  /** Where the request came from — log/display only (default 'out-of-band'). */
  source?: string;
}

function activeIntegration(): Integration | null {
  const row = db.select().from(notionIntegration).all()[0] ?? null;
  return row && row.status === 'active' ? row : null;
}

function dbId(kind: string): string | null {
  return db.select().from(notionDatabases).where(eq(notionDatabases.kind, kind)).all()[0]?.notionDatabaseId ?? null;
}

function barePageId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** Map Org DB page ids (an "Assigned To" relation) to registered agent names. */
function agentNamesForOrgPages(orgPageIds: string[]): string[] {
  if (orgPageIds.length === 0) return [];
  const byOrgPage = new Map(
    db.select().from(agents).all()
      .filter(a => a.orgDbPageId)
      .map(a => [barePageId(a.orgDbPageId as string), a.name] as const),
  );
  return orgPageIds.map(id => byOrgPage.get(barePageId(id))).filter((n): n is string => !!n);
}

async function queryAll(apiKey: string, databaseId: string, filter: unknown, cap: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  while (out.length < cap) {
    const res = await notionQuery<Record<string, unknown>>(apiKey, databaseId, {
      ...(filter ? { filter } : {}),
      page_size: Math.min(100, cap - out.length),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const results = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
    out.push(...results);
    if (!res['has_more'] || typeof res['next_cursor'] !== 'string') break;
    cursor = res['next_cursor'];
  }
  return out;
}

/** All projects (id + name) — the resolution roster. */
async function listProjects(apiKey: string): Promise<ProjectRef[]> {
  const projectsDbId = dbId('projects');
  if (!projectsDbId) return [];
  const rows = await queryAll(apiKey, projectsDbId, null, 100);
  return rows
    .map(r => ({ id: String(r['id'] ?? ''), name: getTitle(r['properties'], 'Name') }))
    .filter(p => p.id);
}

/**
 * Resolve a project given as a page id (dashed or bare) or a name. Name match:
 * case-insensitive exact first, then a UNIQUE contains match. Anything else →
 * not found, with the roster so the agent can ask the user.
 */
async function resolveProject(apiKey: string, input: string):
  Promise<{ ok: true; project: ProjectRef } | { ok: false; projects: ProjectRef[] }> {
  const projects = await listProjects(apiKey);
  const wanted = input.trim();
  const asId = barePageId(wanted);
  if (/^[0-9a-f]{32}$/.test(asId)) {
    const byId = projects.find(p => barePageId(p.id) === asId);
    if (byId) return { ok: true, project: byId };
  }
  const lower = wanted.toLowerCase();
  const exact = projects.filter(p => p.name.trim().toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, project: exact[0]! };
  const contains = projects.filter(p => p.name.toLowerCase().includes(lower));
  if (contains.length === 1) return { ok: true, project: contains[0]! };
  return { ok: false, projects };
}

/** Open (non-terminal) tasks — project-scoped when a project id is given. */
export async function listOpenTasks(apiKey: string, tasksDbId: string, projectId?: string): Promise<OpenTask[]> {
  const statusOr = { or: OPEN_STATUSES.map(s => ({ property: 'Status', select: { equals: s } })) };
  const filter = projectId
    ? { and: [{ property: 'Project', relation: { contains: projectId } }, statusOr] }
    : statusOr;
  const rows = await queryAll(apiKey, tasksDbId, filter, MAX_OPEN_TASKS);
  return rows.map(r => {
    const p = r['properties'];
    return {
      id: String(r['id'] ?? ''),
      title: getTitle(p, 'Name'),
      status: getSelect(p, 'Status') ?? '',
      url: String(r['url'] ?? ''),
      assignedTo: agentNamesForOrgPages(getRelationIds(p, 'Assigned To')),
    };
  }).filter(t => t.id);
}

/** The triage LLM credentials when configured (mirrors auto-propose). */
function similarityLLM(): { provider: 'anthropic' | 'openai'; apiKey: string; baseUrl?: string | null; model: string } | null {
  const settings = getNorcSettings();
  if (!settings) return null;
  const configured = settings.orchestratorProvider === 'openai' ? !!settings.orchestratorBaseUrl : !!settings.orchestratorApiKey;
  if (!configured) return null;
  return {
    provider: settings.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
    apiKey: settings.orchestratorApiKey ?? '',
    baseUrl: settings.orchestratorBaseUrl,
    model: settings.orchestratorModel,
  };
}

/**
 * The duplicate gate: heuristic candidates first, then — when the triage LLM
 * is configured — a semantic judge over them. Exact normalized-title matches
 * always block, whatever the judge says. LLM unavailable/unparseable → fall
 * back to the heuristic verdict (never silently "no duplicates").
 */
export async function findBlockingSimilar(title: string, description: string | undefined, open: OpenTask[]): Promise<SimilarHit[]> {
  const cands = heuristicCandidates(title, open, t => t.title);
  if (cands.length === 0) return [];

  const llm = similarityLLM();
  if (llm) {
    const verdicts = await judgeTaskSimilarity({
      ...llm, title, ...(description ? { description } : {}),
      candidates: cands.map(c => ({ title: c.task.title, status: c.task.status })),
    }).catch(() => null);
    if (verdicts !== null) {
      const reasonByIndex = new Map(verdicts.map(v => [v.index, v.reason]));
      return cands
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => reasonByIndex.has(i) || c.score >= 1)
        .map(({ c, i }) => ({ ...c.task, score: c.score, ...(reasonByIndex.get(i) ? { reason: reasonByIndex.get(i) as string } : {}) }));
    }
    emitLog('external-task duplicate check: LLM judge unavailable — falling back to the title heuristic', 'NORC');
  }
  return cands.filter(c => c.blocking).map(c => ({ ...c.task, score: c.score }));
}

/** GET /api/me/tasks — the agent's pre-check / "what's open here" view. */
export async function listExternalTasks(projectInput?: string, q?: string): Promise<ListOutcome> {
  const integration = activeIntegration();
  if (!integration) return { outcome: 'not_active' };
  const tasksDbId = dbId('tasks');
  if (!tasksDbId) return { outcome: 'no_tasks_db' };

  let project: ProjectRef | null = null;
  if (projectInput && projectInput.trim()) {
    const resolved = await resolveProject(integration.apiKey, projectInput);
    if (!resolved.ok) return { outcome: 'project_not_found', projects: resolved.projects };
    project = resolved.project;
  }

  const open = await listOpenTasks(integration.apiKey, tasksDbId, project?.id);
  const tasks = q && q.trim()
    ? open
        .map(t => ({ ...t, score: Math.round(titleSimilarity(q, t.title) * 100) / 100 }))
        .sort((a, b) => b.score - a.score)
    : open;
  return { outcome: 'ok', project, tasks };
}

/**
 * POST /api/me/tasks — create-or-claim, behind the duplicate gate. Serialized
 * (one intake at a time) so concurrent similar requests can't both pass the
 * check before either creates.
 */
export async function intakeExternalTask(agentRow: AgentRow, input: IntakeInput): Promise<IntakeOutcome> {
  return intakeSemaphore.run(() => intakeLocked(agentRow, input));
}

async function intakeLocked(agentRow: AgentRow, input: IntakeInput): Promise<IntakeOutcome> {
  const integration = activeIntegration();
  if (!integration) return { outcome: 'not_active' };
  const tasksDbId = dbId('tasks');
  if (!tasksDbId) return { outcome: 'no_tasks_db' };
  // Assigned To / agent Status writes need the agent's Org DB page.
  if (!agentRow.orgDbPageId) return { outcome: 'agent_not_in_org' };

  const apiKey = integration.apiKey;
  const source = (input.source ?? 'out-of-band').slice(0, 50);

  // ── claim path: the user said "it's that one" ──
  if (input.existingTaskPageId) {
    let anchor;
    try {
      anchor = await resolveAnchor(apiKey, input.existingTaskPageId);
    } catch {
      return { outcome: 'task_not_found' };
    }
    if (anchor.kind !== 'task') return { outcome: 'not_a_task' };
    const props = (anchor.page as Record<string, unknown>)['properties'];
    const status = getSelect(props, 'Status') ?? '';
    if (status === 'Done' || status === 'Failed') return { outcome: 'task_closed', status };
    if (!CLAIMABLE_STATUSES.has(status)) {
      return { outcome: 'task_already_active', assignedTo: agentNamesForOrgPages(getRelationIds(props, 'Assigned To')) };
    }
    const title = getTitle(props, 'Name');
    const request = input.description?.trim() || `Out-of-band request (${source}): complete the task "${title}".`;
    const claim = await claimExternalTask(integration, agentRow, anchor.pageId, request, source);
    emitLog(`external task: "${agentRow.name}" claimed "${title}" (${claim.mode}, via ${source})`, agentRow.name, anchor.pageId);
    return {
      outcome: 'claimed',
      task: { id: anchor.pageId, title, url: String((anchor.page as Record<string, unknown>)['url'] ?? '') },
      claim,
    };
  }

  // ── create path: duplicate gate, then create + claim ──
  const title = (input.title ?? '').trim();
  if (!title) return { outcome: 'title_required' };

  let project: ProjectRef | null = null;
  if (input.project && input.project.trim()) {
    const resolved = await resolveProject(apiKey, input.project);
    if (!resolved.ok) return { outcome: 'project_not_found', projects: resolved.projects };
    project = resolved.project;
  }

  if (input.force !== true) {
    const open = await listOpenTasks(apiKey, tasksDbId, project?.id);
    const blocking = await findBlockingSimilar(title, input.description, open);
    if (blocking.length > 0) {
      emitLog(`external task "${title}" from "${agentRow.name}" blocked: ${blocking.length} similar open task(s) — the user decides`, agentRow.name);
      return { outcome: 'similar', candidates: blocking };
    }
  }

  const { pageId, url } = await createTaskPage(apiKey, tasksDbId, {
    title,
    kpis: input.kpis ?? '',
    projectId: project?.id ?? null,
    assigneeIds: [agentRow.orgDbPageId],
  });
  const body = [
    input.description?.trim() ?? '',
    `_Created by @${agentRow.name} from an out-of-band request (${source})._`,
  ].filter(Boolean).join('\n\n');
  if (body) await appendBlocks(apiKey, pageId, markdownToBlocks(body)).catch(() => { /* best-effort */ });

  const request = input.description?.trim() || title;
  const claim = await claimExternalTask(integration, agentRow, pageId, request, source);
  emitLog(`external task: "${agentRow.name}" created "${title}" (${claim.mode}${project ? `, project "${project.name}"` : ''}, via ${source})`, agentRow.name, pageId);

  return { outcome: 'created', task: { id: pageId, title, url }, claim };
}
