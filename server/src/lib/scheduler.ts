// Proactive scheduling. Polls the Tasks DB for rows whose "Scheduled For" date is
// due and dispatches them:
//   - one-shot (Recurrence = None): dispatch the task itself (only from Backlog).
//   - recurring (Recurrence != None): the row is a TEMPLATE — spawn a fresh task
//     instance, dispatch that, and advance the template's date to the next
//     occurrence. The template is never worked directly, so each run keeps its own
//     history. Every occurrence is de-duped via processedTriggers.
// Tasks with an inert Status (empty / Draft / Proposed) are held, not consumed:
// flip the Status to Backlog and the next poll fires them.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases, processedTriggers } from '../db/schema.js';
import { notionQuery } from './notion-client.js';
import { getTitle, getRichText, getSelect, getRelationIds } from './notion-props.js';
import { createTaskPage, setTaskScheduledFor } from './notion-writeback.js';
import { isInertTaskStatus } from './notion-provision.js';
import { dispatchScheduledTask } from './orchestrator.js';
import { unmetDependencies } from './task-deps.js';
import { emitLog } from './logger.js';

function alreadyProcessed(key: string): boolean {
  return !!db.select().from(processedTriggers).where(eq(processedTriggers.triggerKey, key)).all()[0];
}
function markProcessed(key: string): void {
  db.insert(processedTriggers).values({ triggerKey: key, createdAt: Date.now() }).onConflictDoNothing().run();
}

/** Read a Notion date property's start (ISO string) or null. */
function getDateStart(props: unknown, name: string): string | null {
  if (!props || typeof props !== 'object') return null;
  const p = (props as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
  const d = p?.['date'] as Record<string, unknown> | undefined;
  return d && typeof d['start'] === 'string' ? d['start'] : null;
}
/** Read a Notion number property or null. */
function getNumber(props: unknown, name: string): number | null {
  if (!props || typeof props !== 'object') return null;
  const p = (props as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
  return typeof p?.['number'] === 'number' ? (p['number'] as number) : null;
}

const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Next occurrence from a fired date. `repeatEvery` (>0) wins over the preset. */
export function nextOccurrence(from: Date, recurrence: string, repeatEvery: number): Date | null {
  if (repeatEvery && repeatEvery > 0) return addDays(from, Math.floor(repeatEvery));
  switch (recurrence) {
    case 'Daily': return addDays(from, 1);
    case 'Weekly': return addDays(from, 7);
    case 'Monthly': { const x = new Date(from); x.setMonth(x.getMonth() + 1); return x; }
    case 'Weekdays': {
      let x = addDays(from, 1);
      while (x.getDay() === 0 || x.getDay() === 6) x = addDays(x, 1); // skip Sun/Sat
      return x;
    }
    default: return null; // None / unknown → no further occurrence
  }
}

async function spawnRecurringInstance(apiKey: string, tasksDbId: string, props: unknown): Promise<string | null> {
  try {
    const { pageId } = await createTaskPage(apiKey, tasksDbId, {
      title: getTitle(props, 'Name') || 'Recurring task',
      kpis: getRichText(props, 'KPIs'),
      projectId: getRelationIds(props, 'Project')[0] ?? null,
      assigneeIds: getRelationIds(props, 'Assigned To'),
      status: 'Backlog',
    });
    return pageId;
  } catch (err) {
    emitLog(`scheduler: failed to spawn recurring instance: ${err instanceof Error ? err.message : 'error'}`, 'Schedule');
    return null;
  }
}

/** One scheduler pass: dispatch every due task (one-shot or recurring). */
export async function runScheduler(): Promise<void> {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active') return;
  const apiKey = integration.apiKey;
  const tasksDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'tasks')).all()[0];
  if (!tasksDb) return;

  let res: Record<string, unknown>;
  try {
    res = await notionQuery<Record<string, unknown>>(apiKey, tasksDb.notionDatabaseId, {
      filter: { property: 'Scheduled For', date: { on_or_before: new Date().toISOString() } },
      page_size: 50,
    });
  } catch (err) {
    emitLog(`scheduler query failed: ${err instanceof Error ? err.message : 'error'}`, 'Schedule');
    return;
  }
  const rows = Array.isArray(res['results']) ? res['results'] as Record<string, unknown>[] : [];

  for (const row of rows) {
    const taskId = String(row['id'] ?? '');
    const props = row['properties'];
    const scheduledFor = getDateStart(props, 'Scheduled For');
    if (!taskId || !scheduledFor) continue;

    const status = getSelect(props, 'Status') ?? '';
    // Inert statuses (empty / Draft / Proposed) hold a due task — one-shot or
    // recurring template — without consuming its occurrence, so setting the
    // Status to Backlog later fires it on the next poll. Log the hold once.
    if (isInertTaskStatus(status)) {
      const holdKey = `schedule-hold:${taskId}:${scheduledFor}:${status}`;
      if (!alreadyProcessed(holdKey)) {
        markProcessed(holdKey);
        emitLog(`scheduler: task ${taskId} is due but Status is ${status || 'empty'} — holding until it's set to Backlog`, 'Schedule');
      }
      continue;
    }

    // Dependency gate: a due task (or recurring template) with unmet "Depends
    // On" deps is held WITHOUT consuming its occurrence — the first poll after
    // the chain completes fires it. Log the hold once per occurrence.
    const unmetDeps = await unmetDependencies(apiKey, props);
    if (unmetDeps.length > 0) {
      const depHoldKey = `schedule-dep-hold:${taskId}:${scheduledFor}`;
      if (!alreadyProcessed(depHoldKey)) {
        markProcessed(depHoldKey);
        emitLog(`scheduler: task ${taskId} is due but waits on ${unmetDeps.length} dependenc${unmetDeps.length === 1 ? 'y' : 'ies'} — holding`, 'Schedule', taskId);
      }
      continue;
    }

    const recurrence = getSelect(props, 'Recurrence') ?? 'None';
    const occKey = `schedule:${taskId}:${scheduledFor}`;
    if (alreadyProcessed(occKey)) continue;
    markProcessed(occKey);

    if (recurrence === 'None' || recurrence === '') {
      if (status !== 'Backlog') continue; // don't re-fire in-progress/done one-shots
      emitLog(`scheduler: firing one-shot task ${taskId}`, 'Schedule');
      await dispatchScheduledTask(integration, taskId, 'scheduled', occKey);
    } else {
      emitLog(`scheduler: recurring template ${taskId} due (${recurrence}) — spawning instance`, 'Schedule');
      const instanceId = await spawnRecurringInstance(apiKey, tasksDb.notionDatabaseId, props);
      if (instanceId) await dispatchScheduledTask(integration, instanceId, 'scheduled (recurring)', `${occKey}:inst`);
      const next = nextOccurrence(new Date(scheduledFor), recurrence, getNumber(props, 'Repeat Every (days)') ?? 0);
      try { await setTaskScheduledFor(apiKey, taskId, next ? next.toISOString() : null); }
      catch (err) { emitLog(`scheduler: failed to advance template ${taskId}: ${err instanceof Error ? err.message : 'error'}`, 'Schedule'); }
    }
  }
}
