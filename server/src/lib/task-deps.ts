// Task dependencies — the "Depends On" relation on the Tasks DB. A task with
// unmet dependencies is HELD (not dispatched, not triaged, not fired by the
// scheduler) and auto-released by the orchestrator when its last dependency
// completes. Pure Notion-read module: no orchestrator import.
//
// What counts as MET:
//   - dep Status === 'Done'
//   - dep page archived / in trash / 404 (met WITH a warning — a dep that can
//     never become Done would deadlock the dependent forever, and Notion 404s
//     deleted and unshared pages alike)
// What counts as UNMET:
//   - any other readable Status (incl. 'Failed' — a failed dep deliberately
//     holds dependents until a human intervenes)
//   - transient API errors (fail safe: hold and retry on the next trigger;
//     never release on uncertainty)

import { notionGet } from './notion-client.js';
import { getRelationIds, getSelect, getAnyTitle } from './notion-props.js';
import { emitLog } from './logger.js';

export interface UnmetDep {
  id: string;
  title: string;
  status: string;
}

export function getDependsOnIds(props: unknown): string[] {
  return getRelationIds(props, 'Depends On');
}

/** Whether a Notion "could not find" error (deleted or unshared page). */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /could not find|object_not_found|\(404\)/i.test(msg);
}

/** The task's dependencies that are not yet complete (see module doc for semantics). */
export async function unmetDependencies(apiKey: string, props: unknown): Promise<UnmetDep[]> {
  const unmet: UnmetDep[] = [];
  for (const id of getDependsOnIds(props)) {
    try {
      const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
      if (page['archived'] === true || page['in_trash'] === true) {
        emitLog(`dependency ${id} is archived/trashed — treating it as met`, 'NORC', id);
        continue;
      }
      const status = getSelect(page['properties'], 'Status') ?? '';
      if (status !== 'Done') {
        unmet.push({ id, title: getAnyTitle(page['properties']) || '(untitled)', status: status || '(no status)' });
      }
    } catch (err) {
      if (isNotFound(err)) {
        emitLog(`dependency ${id} no longer exists — treating it as met`, 'NORC', id);
        continue;
      }
      // Transient failure: hold. The next webhook/poll/release re-checks.
      unmet.push({ id, title: '(unreadable)', status: 'unknown' });
    }
  }
  return unmet;
}

/**
 * Detect a circular "Depends On" chain starting from this task (A→B→…→A).
 * Bounded BFS (≤25 nodes, depth ≤10) — dependency graphs are small, and the
 * walk only runs on the hold path. A cycle is never auto-run; the hold comment
 * tells the human to break it.
 */
export async function detectDependencyCycle(apiKey: string, taskPageId: string, props: unknown): Promise<boolean> {
  const visited = new Set<string>([taskPageId]);
  let frontier = getDependsOnIds(props);
  for (let depth = 0; depth < 10 && frontier.length > 0 && visited.size <= 25; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (id === taskPageId) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      try {
        const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
        next.push(...getDependsOnIds(page['properties']));
      } catch { /* unreadable dep — can't extend the chain through it */ }
    }
    frontier = next;
  }
  return false;
}
