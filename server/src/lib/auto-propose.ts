// Recurring co-CEO analysis. On a schedule NORC acts as a co-CEO: it reads company
// strategy, per-project KPIs/objectives, what was recently SHIPPED (completed/failed
// tasks + agent outputs), and standing routines/habits, folds them into bounded
// rolling memos (a cheap model, incrementally), then PROPOSES new high-leverage work
// — one-shots AND recurring routines — that should move KPIs and grow the business.
// Proposals are created with Status 'Proposed', unassigned, and never auto-dispatched
// — a human validates by moving one to Backlog (+ assigning).
//
// Cost discipline (the workspace grows to many apps over months): each cycle reads
// only bounded WINDOWS (recent completions, capped projects/routines) and keeps a
// per-project rolling memo (project_memo) so unchanged projects are NOT re-summarized
// and the proposal context stays ~constant in size regardless of total history.
//
// Phase 2 (opt-in, autoProposeProbeEnabled): for STALE projects (no recent shipped
// work, past a cooldown) NORC asks the project's agent a progress question. The reply
// lands async as a project-page comment and is folded into that project's memo on the
// NEXT cycle — the memo is the buffer between async replies and proposals.

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases, projectMemo } from '../db/schema.js';
import { notionQuery } from './notion-client.js';
import { getTitle, getRichText, getSelect, getNumber, getDate, getRelationIds } from './notion-props.js';
import { createTaskPage, appendBlocks } from './notion-writeback.js';
import { markdownToBlocks } from './notion-blocks-md.js';
import { resolveAnchor, listThreadComments } from './notion-anchor.js';
import { matchAgents } from './notion-mentions.js';
import { requestAgentTurn } from './orchestrator.js';
import { getNorcSettings, upsertNorcSettings } from './norc-settings.js';
import { summarizeMemo, proposeBusinessTasks, type ProposedBizTask, type LLMConfig } from './orchestrator-agent.js';
import { assembleWithBudget, type Section } from './context-assembler.js';
import { emitLog } from './logger.js';

const envNum = (key: string, fallback: number): number => Number(process.env[key]) || fallback;

// Sizing — env-overridable, mirroring NORC_MAX_CONTEXT_CHARS. These bound cost/size.
const MAX_PROPOSALS          = envNum('NORC_AUTOPROPOSE_MAX', 3);
const RECENT_WINDOW_DAYS     = envNum('NORC_AUTOPROPOSE_WINDOW_DAYS', 14);   // "recent" completions window
const MAX_COMPLETED_TASKS    = envNum('NORC_AUTOPROPOSE_MAX_DONE', 15);
const MAX_ROUTINES           = envNum('NORC_AUTOPROPOSE_MAX_ROUTINES', 20);
const MAX_PROJECTS           = envNum('NORC_AUTOPROPOSE_MAX_PROJECTS', 30);
const COMPLETION_OUTPUT_SLICE = envNum('NORC_AUTOPROPOSE_OUTPUT_SLICE', 300); // per-completion Agent Output
const OPEN_TITLE_SAMPLE      = envNum('NORC_AUTOPROPOSE_OPEN_SAMPLE', 25);    // titles shown in prompt (dedup uses ALL)
const PROJECT_SIGNAL_MAX_CHARS = envNum('NORC_PROJECT_SIGNAL_MAX_CHARS', 1500); // per-project signals → stage 2
const PROJECT_MEMO_MAX_CHARS = envNum('NORC_PROJECT_MEMO_MAX_CHARS', 800);    // per-project memo cap
const GLOBAL_MEMO_MAX_CHARS  = envNum('NORC_CEO_MEMO_MAX_CHARS', 2000);       // cross-portfolio memo cap
const STAGE3_MAX_CHARS       = envNum('NORC_AUTOPROPOSE_STAGE3_CHARS', 14000); // whole proposal context

type ProjectMemoRow = typeof projectMemo.$inferSelect;
type Integration = typeof notionIntegration.$inferSelect;

function dbId(kind: string): string | null {
  return db.select().from(notionDatabases).where(eq(notionDatabases.kind, kind)).all()[0]?.notionDatabaseId ?? null;
}

async function rows(apiKey: string, databaseId: string, body: unknown): Promise<Record<string, unknown>[]> {
  try {
    const res = await notionQuery<Record<string, unknown>>(apiKey, databaseId, body);
    return Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
  } catch { return []; }
}

function pushTo(map: Map<string, string[]>, key: string, line: string): void {
  const arr = map.get(key);
  if (arr) arr.push(line); else map.set(key, [line]);
}

/** First line of a memo (its headline), or the whole string if single-line. */
const firstLine = (s: string): string => s.split('\n')[0] ?? s;

interface ProjectInfo { projectId: string; name: string; objective: string; kpis: string; agentIds: string[] }
interface Signals {
  company: string;
  projects: ProjectInfo[];
  completionsByProject: Map<string, string[]>;
  routinesByProject: Map<string, string[]>;
  allCompletions: string[];
  routinesAll: string[];
  openTitles: string[];
  openCounts: Record<string, number>;
}

/** One bounded sweep of company/portfolio signals. Every read is windowed/capped,
 *  so the result size doesn't grow with total history. */
async function gatherSignals(apiKey: string, tasksId: string): Promise<Signals> {
  // Company strategy (Active rows only) — small.
  let company = '';
  const companyId = dbId('company');
  if (companyId) {
    const rowsC = await rows(apiKey, companyId, { filter: { property: 'Status', select: { equals: 'Active' } }, page_size: 10 });
    company = rowsC.map(r => {
      const p = r['properties'];
      return `- (${getSelect(p, 'Type') ?? ''}) ${getTitle(p, 'Name')}: ${getRichText(p, 'Content')}`.trim();
    }).join('\n');
  }

  // Projects (capped) — name + objective + KPIs + owning agents.
  const projects: ProjectInfo[] = [];
  const projectsId = dbId('projects');
  if (projectsId) {
    for (const r of await rows(apiKey, projectsId, { page_size: MAX_PROJECTS })) {
      const id = String(r['id'] ?? '');
      if (!id) continue;
      const p = r['properties'];
      projects.push({
        projectId: id,
        name: getTitle(p, 'Name'),
        objective: getRichText(p, 'Objective'),
        kpis: getRichText(p, 'KPIs'),
        agentIds: getRelationIds(p, 'Agents'),
      });
    }
  }

  // Recent completions (windowed) — sorted newest-first, capped to one page; the
  // window is enforced in JS from the row's last_edited_time so the query stays a
  // single, simple status filter (and degrades to [] on any error via rows()).
  const completionsByProject = new Map<string, string[]>();
  const allCompletions: string[] = [];
  const windowMs = Date.now() - RECENT_WINDOW_DAYS * 86_400_000;
  const done = await rows(apiKey, tasksId, {
    filter: { or: [
      { property: 'Status', select: { equals: 'Done' } },
      { property: 'Status', select: { equals: 'Failed' } },
    ] },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    page_size: MAX_COMPLETED_TASKS,
  });
  for (const r of done) {
    const edited = Date.parse(String(r['last_edited_time'] ?? '')) || 0;
    if (edited && edited < windowMs) continue; // outside the recency window
    const p = r['properties'];
    const out = getRichText(p, 'Agent Output').replace(/\s+/g, ' ').trim().slice(0, COMPLETION_OUTPUT_SLICE);
    const line = `- [${getSelect(p, 'Status') ?? '?'}] ${getTitle(p, 'Name')}${out ? ` — ${out}` : ''}`;
    allCompletions.push(line);
    const pid = getRelationIds(p, 'Project')[0];
    if (pid) pushTo(completionsByProject, pid, line);
  }

  // Standing routines/habits (recurring templates only).
  const routinesByProject = new Map<string, string[]>();
  const routinesAll: string[] = [];
  const rt = await rows(apiKey, tasksId, {
    filter: { and: [
      { property: 'Recurrence', select: { does_not_equal: 'None' } },
      { property: 'Recurrence', select: { is_not_empty: true } },
    ] },
    page_size: MAX_ROUTINES,
  });
  for (const r of rt) {
    const p = r['properties'];
    const every = getNumber(p, 'Repeat Every (days)');
    const next = getDate(p, 'Scheduled For');
    const cadence = every && every > 0 ? `every ${Math.floor(every)}d` : (getSelect(p, 'Recurrence') ?? 'recurring').toLowerCase();
    const line = `- ${getTitle(p, 'Name')} (${cadence}${next ? `, next ${next.slice(0, 10)}` : ''})`;
    routinesAll.push(line);
    const pid = getRelationIds(p, 'Project')[0];
    if (pid) pushTo(routinesByProject, pid, line);
  }

  // Open work — full title set for dedup; counts/sample for the prompt.
  const openTitles: string[] = [];
  const openCounts: Record<string, number> = {};
  const open = await rows(apiKey, tasksId, {
    filter: { or: [
      { property: 'Status', select: { equals: 'Draft' } },
      { property: 'Status', select: { equals: 'Backlog' } },
      { property: 'Status', select: { equals: 'In Progress' } },
      { property: 'Status', select: { equals: 'Proposed' } },
    ] },
    page_size: 100,
  });
  for (const r of open) {
    const p = r['properties'];
    const t = getTitle(p, 'Name');
    if (t) openTitles.push(t);
    const st = getSelect(p, 'Status') ?? 'Unknown';
    openCounts[st] = (openCounts[st] ?? 0) + 1;
  }

  return { company, projects, completionsByProject, routinesByProject, allCompletions, routinesAll, openTitles, openCounts };
}

/** Fold any unread probe replies (project-page comments since the last memo update)
 *  into the per-project signals. Bounded: only projects probed since their memo was
 *  last written are read. Returns a map projectId → "team note" line(s). */
async function gatherProbeReplies(apiKey: string, memos: Map<string, ProjectMemoRow>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [pid, m] of memos) {
    if (!m.lastProbeAt) continue;
    if (m.updatedAt && m.lastProbeAt <= m.updatedAt) continue; // already folded in
    let comments;
    try { comments = await listThreadComments(apiKey, pid); } catch { continue; }
    const since = m.lastProbeAt;
    // The probe question is sent to the agent as a prompt (not posted), so every
    // comment after we asked is fair game — the agent's reply (posted by NORC) and
    // any human note both count as the project's latest progress signal.
    const replies = comments
      .filter(c => (Date.parse(c.createdTime ?? '') || 0) >= since)
      .map(c => c.plainText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (replies.length) out.set(pid, replies.slice(-3).join(' | ').slice(0, PROJECT_SIGNAL_MAX_CHARS));
  }
  return out;
}

/** Stage 2: incrementally update per-project + global memos with a (cheap) model.
 *  Only projects whose signals changed are re-summarized — that's the cost bound. */
async function updateMemos(apiKey: string, signals: Signals, cfgCheap: LLMConfig): Promise<{ globalMemo: string; activeProjectIds: Set<string> }> {
  const active = new Set<string>();
  const memos = new Map<string, ProjectMemoRow>();
  for (const m of db.select().from(projectMemo).all()) memos.set(m.projectId, m);
  const probeReplies = await gatherProbeReplies(apiKey, memos);

  const headlines: string[] = [];
  for (const proj of signals.projects) {
    const comps = signals.completionsByProject.get(proj.projectId) ?? [];
    const rts = signals.routinesByProject.get(proj.projectId) ?? [];
    const probe = probeReplies.get(proj.projectId);
    const projSignals = [
      `Project: ${proj.name}`,
      proj.objective ? `Objective: ${proj.objective}` : '',
      proj.kpis ? `KPIs: ${proj.kpis}` : '',
      comps.length ? `Recently shipped:\n${comps.join('\n')}` : 'Recently shipped: (nothing in window)',
      rts.length ? `Routines:\n${rts.join('\n')}` : '',
      probe ? `Team progress note: ${probe}` : '',
    ].filter(Boolean).join('\n').slice(0, PROJECT_SIGNAL_MAX_CHARS);

    const hash = createHash('sha256').update(projSignals).digest('hex').slice(0, 16);
    const prev = memos.get(proj.projectId);
    let memo = prev?.memo ?? '';

    if (!prev || prev.signalHash !== hash) {
      const updated = await summarizeMemo({
        ...cfgCheap, prevMemo: memo, signals: projSignals,
        maxChars: PROJECT_MEMO_MAX_CHARS, scope: 'project', label: proj.name,
      });
      // Persist (and consume the hash) only when the memo actually changed — if the
      // LLM was down it returns the prior memo, so we leave the hash and retry next cycle.
      if (updated !== memo) {
        memo = updated;
        active.add(proj.projectId);
        const now = Date.now();
        try {
          db.insert(projectMemo)
            .values({ projectId: proj.projectId, title: proj.name, memo, kpiNote: prev?.kpiNote ?? null, signalHash: hash, lastProbeAt: prev?.lastProbeAt ?? null, updatedAt: now })
            .onConflictDoUpdate({ target: projectMemo.projectId, set: { title: proj.name, memo, signalHash: hash, updatedAt: now } })
            .run();
        } catch (err) { emitLog(`auto-propose: memo write failed for "${proj.name}": ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO'); }
      }
    }
    if (memo) headlines.push(`- ${proj.name}: ${firstLine(memo).slice(0, 160)}`);
  }

  // Cross-portfolio executive memo from the per-project headlines.
  const settings = getNorcSettings();
  let globalMemo = settings?.ceoMemo ?? '';
  if (headlines.length) {
    const updated = await summarizeMemo({
      ...cfgCheap, prevMemo: globalMemo, signals: headlines.join('\n'),
      maxChars: GLOBAL_MEMO_MAX_CHARS, scope: 'global',
    });
    if (updated !== globalMemo) {
      globalMemo = updated;
      try { upsertNorcSettings({ ceoMemo: globalMemo, ceoMemoUpdatedAt: Date.now() }); } catch { /* best-effort */ }
    }
  }
  return { globalMemo, activeProjectIds: active };
}

/** Stage 3: assemble a budget-bounded context (active projects = full memo, quiet =
 *  headline) and ask the main model for proposals. */
async function proposeFromCeo(signals: Signals, globalMemo: string, activeProjectIds: Set<string>, cfgMain: LLMConfig): Promise<ProposedBizTask[]> {
  const memos = new Map<string, ProjectMemoRow>();
  for (const m of db.select().from(projectMemo).all()) memos.set(m.projectId, m);

  const sections: Section[] = [];
  let order = 0;
  if (signals.company) sections.push({ text: `[COMPANY]\n${signals.company}`, priority: 0, order: order++ });

  const openSummary = Object.entries(signals.openCounts).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none';
  const sample = signals.openTitles.slice(0, OPEN_TITLE_SAMPLE).map(t => `- ${t}`).join('\n');
  sections.push({ text: `[OPEN WORK] ${openSummary}${sample ? `\nSample:\n${sample}` : ''}`, priority: 2, order: order++ });
  if (signals.allCompletions.length) {
    sections.push({ text: `[RECENTLY SHIPPED]\n${signals.allCompletions.join('\n')}`, priority: 2, order: order++ });
  }

  // Per-project memos: active (changed this cycle) get the full slice; quiet ones a
  // one-line headline. assembleWithBudget keeps high-priority full memos and truncates
  // the low-priority tail first, so this stays bounded even at 20–30 apps.
  for (const proj of signals.projects) {
    const m = memos.get(proj.projectId);
    if (!m?.memo) continue;
    const isActive = activeProjectIds.has(proj.projectId);
    sections.push({
      text: isActive ? `## ${proj.name}\n${m.memo}` : `## ${proj.name}\n${firstLine(m.memo)}`,
      priority: isActive ? 1 : 3,
      order: order++,
    });
  }
  const projectContext = assembleWithBudget(sections, STAGE3_MAX_CHARS);

  const kpis = signals.projects
    .map(p => `- ${p.name}${p.objective ? ` — ${p.objective}` : ''}${p.kpis ? ` [KPIs: ${p.kpis}]` : ''}`)
    .join('\n');

  return proposeBusinessTasks({
    ...cfgMain,
    globalMemo,
    projectContext,
    kpis,
    routines: signals.routinesAll.join('\n'),
    existingTitles: signals.openTitles.slice(0, OPEN_TITLE_SAMPLE),
    max: MAX_PROPOSALS,
    allowRoutines: true,
  });
}

/** Phase 2 (gated): probe the owning agent of STALE projects for a progress update.
 *  Skips projects that shipped recently, have no owner, or were probed within the
 *  cooldown. Replies land async and are folded into the memo on the next cycle. */
async function probeStaleProjects(integration: Integration, signals: Signals, cooldownHours: number): Promise<void> {
  const now = Date.now();
  const cooldownMs = Math.max(1, cooldownHours) * 3_600_000;
  const memos = new Map<string, ProjectMemoRow>();
  for (const m of db.select().from(projectMemo).all()) memos.set(m.projectId, m);

  let probed = 0;
  for (const proj of signals.projects) {
    if (!proj.kpis && !proj.objective) continue;                                   // nothing measurable to ask about
    if ((signals.completionsByProject.get(proj.projectId)?.length ?? 0) > 0) continue; // evolved recently → infer instead
    if (!proj.agentIds.length) continue;                                           // no owner to ask
    const prev = memos.get(proj.projectId);
    if (prev?.lastProbeAt && now - prev.lastProbeAt < cooldownMs) continue;        // cooldown
    const agent = matchAgents(proj.agentIds)[0];
    if (!agent) continue;

    let anchor;
    try { anchor = await resolveAnchor(integration.apiKey, proj.projectId); } catch { continue; }
    const question = `🧭 **NORC co-CEO progress check** for **${proj.name}**.\n\nWhere do we stand on this project's KPIs${proj.kpis ? ` (${proj.kpis})` : ''}? Briefly: what's done, what's in progress, what's blocked, and your read on KPI progress. This feeds portfolio planning — no need to start new work.`;
    try {
      await requestAgentTurn(integration, anchor, agent, {
        thread: [], request: question, manageTaskStatus: false, how: 'co-CEO progress probe', lane: 'chat',
      });
      const ts = Date.now();
      // updatedAt = "when the memo CONTENT was last written" — distinct from lastProbeAt.
      // A probe-only row has no content yet, so seed updatedAt to 0 ("never written")
      // so gatherProbeReplies captures the agent's async reply on a later cycle.
      db.insert(projectMemo)
        .values({ projectId: proj.projectId, title: proj.name, memo: prev?.memo ?? '', kpiNote: prev?.kpiNote ?? null, signalHash: prev?.signalHash ?? null, lastProbeAt: ts, updatedAt: prev?.updatedAt ?? 0 })
        .onConflictDoUpdate({ target: projectMemo.projectId, set: { lastProbeAt: ts } })
        .run();
      probed++;
    } catch (err) {
      emitLog(`auto-propose: probe failed for "${proj.name}": ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
    }
  }
  if (probed) emitLog(`auto-propose: probed ${probed} stale project(s) for progress`, 'Co-CEO');
}

/** One co-CEO analysis pass: gather → (probe) → update memos → propose. */
export async function runAutoPropose(): Promise<void> {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') return;
  const settings = getNorcSettings();
  if (!settings) { emitLog('auto-propose skipped: settings unset', 'Co-CEO'); return; }
  // Reuses the triage LLM credentials (independent of the orchestrator toggle).
  const configured = settings.orchestratorProvider === 'openai' ? !!settings.orchestratorBaseUrl : !!settings.orchestratorApiKey;
  if (!configured) { emitLog('auto-propose skipped: triage LLM not configured', 'Co-CEO'); return; }

  const apiKey = integration.apiKey;
  const tasksId = dbId('tasks');
  if (!tasksId) { emitLog('auto-propose skipped: no Tasks DB', 'Co-CEO'); return; }

  const cfgMain: LLMConfig = {
    provider: settings.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
    apiKey: settings.orchestratorApiKey ?? '', baseUrl: settings.orchestratorBaseUrl, model: settings.orchestratorModel,
  };
  const cfgCheap: LLMConfig = { ...cfgMain, model: settings.autoProposeSummaryModel?.trim() || settings.orchestratorModel };

  const signals = await gatherSignals(apiKey, tasksId);

  // Phase 2 (opt-in): ask stale projects' agents for progress. Replies feed the NEXT
  // cycle's memo — we run it before updateMemos so earlier replies are already folded in.
  if (settings.autoProposeProbeEnabled) {
    try { await probeStaleProjects(integration, signals, settings.autoProposeProbeCooldownHours); }
    catch (err) { emitLog(`auto-propose: probing failed: ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO'); }
  }

  // Stage 2 — incremental memos (cheap model). Degrades to prior memos on failure.
  let globalMemo = settings.ceoMemo ?? '';
  let activeProjectIds = new Set<string>();
  try {
    const r = await updateMemos(apiKey, signals, cfgCheap);
    globalMemo = r.globalMemo; activeProjectIds = r.activeProjectIds;
  } catch (err) {
    emitLog(`auto-propose: memo update failed: ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
  }

  // Stage 3 — propose (main model).
  let proposals: ProposedBizTask[];
  try {
    proposals = await proposeFromCeo(signals, globalMemo, activeProjectIds, cfgMain);
  } catch (err) {
    emitLog(`auto-propose: LLM failed: ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
    return;
  }

  // Create proposals (one-shots + routines), deduped against ALL open titles.
  const existingLower = new Set(signals.openTitles.map(t => t.toLowerCase()));
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  let created = 0;
  for (const t of proposals) {
    if (existingLower.has(t.title.toLowerCase())) continue; // skip duplicates
    const isRoutine = !!(t.recurrence || t.repeatEveryDays);
    try {
      const { pageId } = await createTaskPage(apiKey, tasksId, {
        title: t.title, kpis: t.kpis ?? '', status: 'Proposed',
        ...(isRoutine ? {
          recurrence: t.recurrence ?? 'Weekly',
          ...(t.repeatEveryDays ? { repeatEveryDays: t.repeatEveryDays } : {}),
          scheduledFor: t.scheduledFor ?? tomorrow,
        } : {}),
      });
      const note = isRoutine
        ? '_Proposed routine by the NORC co-CEO — move to **Backlog** to activate it (held until then)._'
        : '_Proposed by the NORC co-CEO — review and assign to approve._';
      const body = [t.rationale ? `**Why now:** ${t.rationale}` : '', note].filter(Boolean).join('\n\n');
      if (body) await appendBlocks(apiKey, pageId, markdownToBlocks(body)).catch(() => { /* best-effort */ });
      created++;
      existingLower.add(t.title.toLowerCase());
    } catch (err) {
      emitLog(`auto-propose: failed to create "${t.title}": ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
    }
  }

  emitLog(
    `auto-propose: ${signals.projects.length} project(s), ${activeProjectIds.size} memo(s) refreshed, global memo ${globalMemo.length}c — created ${created} proposal(s)`,
    'Co-CEO',
  );
}
