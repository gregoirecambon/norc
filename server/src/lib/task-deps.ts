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
import { getRelationIds, getSelect, getAnyTitle, getRichText } from './notion-props.js';
import { readPageMarkdown, listPageMedia, type MediaRef } from './notion-anchor.js';
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

/** One artifact (image/file) a predecessor left, with a freshly-resolved URL. */
export interface DependencyArtifact {
  kind: 'image' | 'file';
  name: string;
  url: string;
  caption: string;
}

/** The handed-off context from one completed predecessor task. */
export interface DependencyContext {
  id: string;
  name: string;
  status: string;
  /** The concise "Agent Output" property the predecessor's agent set. */
  summary: string;
  /** The full page body: free-form text + inline image/file URLs, in order. */
  body: string;
  /** Distilled image/file list, so the dependent can embed each without parsing the body. */
  artifacts: DependencyArtifact[];
}

const DEPENDENCY_BODY_MAX_CHARS = 3500;
const MAX_DEPS_READ = 8;

/**
 * Build the handed-off context from a task's completed predecessors — what a
 * dependent agent needs to build on. For each "Depends On" task (capped, best-
 * effort): its name/status, the concise Agent Output summary, the FULL page body
 * (free-form text + inline image/file URLs in document order — this is where a
 * mix of images and text lives), and a distilled artifact list for easy
 * embedding. Notion file URLs are signed + short-lived, so they're resolved
 * FRESH here at dispatch time, never cached. Unreadable predecessors are skipped
 * (the dependent still has its own context; unmetDependencies governs whether it
 * runs at all).
 */
export async function resolveDependencyContext(apiKey: string, props: unknown): Promise<DependencyContext[]> {
  const out: DependencyContext[] = [];
  for (const id of getDependsOnIds(props).slice(0, MAX_DEPS_READ)) {
    try {
      const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${id}`);
      const pp = page['properties'];
      const name = getAnyTitle(pp) || '(untitled)';
      const status = getSelect(pp, 'Status') ?? '';
      const summary = getRichText(pp, 'Agent Output');
      let body = '';
      try { body = (await readPageMarkdown(apiKey, id, DEPENDENCY_BODY_MAX_CHARS)).trim(); }
      catch { /* body is best-effort */ }
      let media: MediaRef[] = [];
      try { media = await listPageMedia(apiKey, id); }
      catch { /* artifacts are best-effort */ }
      const artifacts: DependencyArtifact[] = media.map(m => ({ kind: m.kind, name: m.name, url: m.url, caption: m.caption }));
      out.push({ id, name, status, summary, body, artifacts });
    } catch {
      // Unreadable predecessor (deleted / unshared / transient) — skip it.
    }
  }
  return out;
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
