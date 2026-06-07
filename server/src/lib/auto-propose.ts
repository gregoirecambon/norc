// Recurring co-CEO analysis. On a schedule, the Triage Agent reviews company
// context (vision/strategy, active projects, open tasks) and PROPOSES new tasks.
// Proposals are created with Status 'Proposed', unassigned, and are never
// auto-dispatched — a human validates them by moving one to Backlog + assigning.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases } from '../db/schema.js';
import { notionQuery } from './notion-client.js';
import { getTitle, getRichText, getSelect } from './notion-props.js';
import { createTaskPage, appendBlocks } from './notion-writeback.js';
import { markdownToBlocks } from './notion-blocks-md.js';
import { getNorcSettings } from './norc-settings.js';
import { proposeBusinessTasks } from './orchestrator-agent.js';
import { emitLog } from './logger.js';

const MAX_PROPOSALS = 3;

function dbId(kind: string): string | null {
  return db.select().from(notionDatabases).where(eq(notionDatabases.kind, kind)).all()[0]?.notionDatabaseId ?? null;
}

async function rows(apiKey: string, databaseId: string, body: unknown): Promise<Record<string, unknown>[]> {
  try {
    const res = await notionQuery<Record<string, unknown>>(apiKey, databaseId, body);
    return Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];
  } catch { return []; }
}

/** Build a compact context digest + the list of open task titles (for dedup). */
async function gatherContext(apiKey: string): Promise<{ context: string; existingTitles: string[] }> {
  const lines: string[] = [];

  const companyId = dbId('company');
  if (companyId) {
    const company = await rows(apiKey, companyId, {
      filter: { property: 'Status', select: { equals: 'Active' } }, page_size: 10,
    });
    if (company.length) {
      lines.push('Company:');
      for (const r of company) {
        const p = r['properties'];
        lines.push(`- (${getSelect(p, 'Type') ?? ''}) ${getTitle(p, 'Name')}: ${getRichText(p, 'Content')}`.trim());
      }
    }
  }

  const projectsId = dbId('projects');
  if (projectsId) {
    const projects = await rows(apiKey, projectsId, { page_size: 20 });
    if (projects.length) {
      lines.push('\nActive projects:');
      for (const r of projects) {
        const p = r['properties'];
        const obj = getRichText(p, 'Objective'); const kpis = getRichText(p, 'KPIs');
        lines.push(`- ${getTitle(p, 'Name')}${obj ? ` — ${obj}` : ''}${kpis ? ` [KPIs: ${kpis}]` : ''}`);
      }
    }
  }

  const existingTitles: string[] = [];
  const tasksId = dbId('tasks');
  if (tasksId) {
    const open = await rows(apiKey, tasksId, {
      filter: { or: [
        { property: 'Status', select: { equals: 'Draft' } },
        { property: 'Status', select: { equals: 'Backlog' } },
        { property: 'Status', select: { equals: 'In Progress' } },
        { property: 'Status', select: { equals: 'Proposed' } },
      ] }, page_size: 100,
    });
    for (const r of open) {
      const t = getTitle(r['properties'], 'Name');
      if (t) existingTitles.push(t);
    }
    if (existingTitles.length) lines.push(`\nOpen tasks: ${existingTitles.length}`);
  }

  return { context: lines.join('\n'), existingTitles };
}

/** One co-CEO analysis pass: propose tasks (as 'Proposed') for human validation. */
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

  const { context, existingTitles } = await gatherContext(apiKey);
  const existingLower = new Set(existingTitles.map(t => t.toLowerCase()));

  let proposals;
  try {
    proposals = await proposeBusinessTasks({
      provider: settings.orchestratorProvider === 'openai' ? 'openai' : 'anthropic',
      apiKey: settings.orchestratorApiKey ?? '', baseUrl: settings.orchestratorBaseUrl, model: settings.orchestratorModel,
      context, existingTitles, max: MAX_PROPOSALS,
    });
  } catch (err) {
    emitLog(`auto-propose: LLM failed: ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
    return;
  }

  let created = 0;
  for (const t of proposals) {
    if (existingLower.has(t.title.toLowerCase())) continue; // skip duplicates
    try {
      const { pageId } = await createTaskPage(apiKey, tasksId, { title: t.title, kpis: t.kpis ?? '', status: 'Proposed' });
      const body = [t.rationale ? `**Why now:** ${t.rationale}` : '', '_Proposed by the NORC Triage Agent — review and assign to approve._']
        .filter(Boolean).join('\n\n');
      if (body) await appendBlocks(apiKey, pageId, markdownToBlocks(body)).catch(() => { /* best-effort */ });
      created++;
      existingLower.add(t.title.toLowerCase());
    } catch (err) {
      emitLog(`auto-propose: failed to create "${t.title}": ${err instanceof Error ? err.message : 'error'}`, 'Co-CEO');
    }
  }

  emitLog(created > 0
    ? `auto-propose: created ${created} proposed task(s) for validation`
    : 'auto-propose: no new proposals this cycle', 'Co-CEO');
}
