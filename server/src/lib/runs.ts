// Run tracking — the bridge that lets an agent report back to the right Notion
// page. Each dispatch mints a row with an opaque `token`; the token travels in
// the agent's prompt (execution contract). When the agent calls the Agent API,
// NORC looks up the token → run → page, so writes always land on the page the
// work came from. Mirrors the handshake nonce + timeout-sweep pattern.

import { randomUUID, randomBytes } from 'node:crypto';
import { eq, lt, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, taskRuns } from '../db/schema.js';
import { emitEvent } from './events.js';

export type RunStatus = 'in_flight' | 'done' | 'failed' | 'timed_out';

export type TaskRun = typeof taskRuns.$inferSelect;

export interface NewRun {
  agentId: string;
  pageId: string;
  taskPageId: string | null;
  anchorKind: string;
  /** Page/task title snapshot at dispatch time — display only (dashboard). */
  title?: string | null;
  /** The Notion project this run belongs to — the per-(agent, project) serialization key. */
  projectId?: string | null;
  /** 'work' runs are capacity-gated/queued; 'chat' runs are parallel and exempt. */
  lane?: 'work' | 'chat';
  manageTaskStatus: boolean;
  /** The human who triggered this run — re-@mentioned if it later times out. */
  triggeringUserId?: string | null;
}

/** Create an in-flight run and return its id + opaque token. */
export function createRun(input: NewRun): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(24).toString('hex');
  const createdAt = Date.now();
  db.insert(taskRuns).values({
    id,
    token,
    agentId: input.agentId,
    pageId: input.pageId,
    taskPageId: input.taskPageId,
    anchorKind: input.anchorKind,
    title: input.title ?? null,
    projectId: input.projectId ?? null,
    lane: input.lane ?? 'work',
    triggeringUserId: input.triggeringUserId ?? null,
    manageTaskStatus: input.manageTaskStatus,
    status: 'in_flight',
    agentActed: false,
    createdAt,
  }).run();
  const agentName = db.select().from(agents).where(eq(agents.id, input.agentId)).all()[0]?.name ?? 'unknown';
  emitEvent({
    type: 'run.started',
    data: {
      id, agentId: input.agentId, agentName,
      title: input.title ?? null, anchorKind: input.anchorKind,
      pageId: input.pageId, createdAt,
    },
  });
  return { id, token };
}

/** Resolve a token to its run, only while still in flight. */
export function getActiveRunByToken(token: string): TaskRun | null {
  const row = db.select().from(taskRuns).where(eq(taskRuns.token, token)).all()[0] ?? null;
  if (!row || row.status !== 'in_flight') return null;
  return row;
}

/** Mark that the agent has performed at least one API action on this run. */
export function markActed(id: string): void {
  db.update(taskRuns).set({ agentActed: true }).where(eq(taskRuns.id, id)).run();
}

export function getRun(id: string): TaskRun | null {
  return db.select().from(taskRuns).where(eq(taskRuns.id, id)).all()[0] ?? null;
}

/** Has this agent had any prior run on this page? (first-visit detection) */
export function hasPriorRunOnPage(agentId: string, pageId: string): boolean {
  return !!db.select().from(taskRuns)
    .where(and(eq(taskRuns.agentId, agentId), eq(taskRuns.pageId, pageId)))
    .all()[0];
}

/** Is this agent mid-task (a run still in flight)? Heartbeat uses this to avoid
 * flipping a working agent's Notion Status. */
export function hasInFlightRun(agentId: string): boolean {
  return !!db.select().from(taskRuns)
    .where(and(eq(taskRuns.agentId, agentId), eq(taskRuns.status, 'in_flight')))
    .all()[0];
}

/** In-flight WORK runs for this agent — the number compared against the
 * agent's maxConcurrentRuns cap. Chat-lane runs are exempt (parallel). */
export function activeRunCount(agentId: string): number {
  return db.select().from(taskRuns)
    .where(and(eq(taskRuns.agentId, agentId), eq(taskRuns.status, 'in_flight'), eq(taskRuns.lane, 'work')))
    .all().length;
}

/**
 * Does this agent already have an in-flight work run on the same page or the
 * same project? The HARD serialization rule: one session per (agent, project)
 * — and per (agent, page), since two runs on one page would share the
 * adapter's per-page session memory.
 */
export function hasRunConflict(agentId: string, projectId: string | null, pageId: string): boolean {
  const inFlight = db.select().from(taskRuns)
    .where(and(eq(taskRuns.agentId, agentId), eq(taskRuns.status, 'in_flight'), eq(taskRuns.lane, 'work')))
    .all();
  return inFlight.some(r => r.pageId === pageId || (projectId !== null && r.projectId === projectId));
}

/** Distinct agent ids that have a timed-out run on this page — the Triage Agent
 * excludes these when re-routing so it doesn't pick an agent that already failed. */
export function timedOutAgentIdsForPage(pageId: string): string[] {
  const rows = db.select().from(taskRuns)
    .where(and(eq(taskRuns.pageId, pageId), eq(taskRuns.status, 'timed_out')))
    .all();
  return [...new Set(rows.map(r => r.agentId))];
}

/** Finalize a run (terminal). No-op if already finalized. */
export function finalizeRun(id: string, status: Exclude<RunStatus, 'in_flight'>): void {
  const completedAt = Date.now();
  const result = db.update(taskRuns)
    .set({ status, completedAt })
    .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'in_flight')))
    .run();
  // Emit only when a row actually transitioned — double-finalize stays silent.
  if (result.changes > 0) {
    const run = getRun(id);
    if (run) emitEvent({ type: 'run.finished', data: { id, agentId: run.agentId, status, completedAt } });
  }
}

/** Time out runs still in flight after maxAgeMs; returns the timed-out rows. */
export function sweepStaleRuns(maxAgeMs: number): TaskRun[] {
  const cutoff = Date.now() - maxAgeMs;
  const stale = db.select().from(taskRuns)
    .where(and(eq(taskRuns.status, 'in_flight'), lt(taskRuns.createdAt, cutoff)))
    .all();
  if (stale.length === 0) return [];
  const completedAt = Date.now();
  db.update(taskRuns)
    .set({ status: 'timed_out', completedAt })
    .where(inArray(taskRuns.id, stale.map(r => r.id)))
    .run();
  for (const r of stale) {
    emitEvent({ type: 'run.finished', data: { id: r.id, agentId: r.agentId, status: 'timed_out', completedAt } });
  }
  return stale;
}
