// Run tracking — the bridge that lets an agent report back to the right Notion
// page. Each dispatch mints a row with an opaque `token`; the token travels in
// the agent's prompt (execution contract). When the agent calls the Agent API,
// NORC looks up the token → run → page, so writes always land on the page the
// work came from. Mirrors the handshake nonce + timeout-sweep pattern.

import { randomUUID, randomBytes } from 'node:crypto';
import { eq, lt, and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { taskRuns } from '../db/schema.js';

export type RunStatus = 'in_flight' | 'done' | 'failed' | 'timed_out';

export type TaskRun = typeof taskRuns.$inferSelect;

export interface NewRun {
  agentId: string;
  pageId: string;
  taskPageId: string | null;
  anchorKind: string;
  manageTaskStatus: boolean;
  /** The human who triggered this run — re-@mentioned if it later times out. */
  triggeringUserId?: string | null;
}

/** Create an in-flight run and return its id + opaque token. */
export function createRun(input: NewRun): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(24).toString('hex');
  db.insert(taskRuns).values({
    id,
    token,
    agentId: input.agentId,
    pageId: input.pageId,
    taskPageId: input.taskPageId,
    anchorKind: input.anchorKind,
    triggeringUserId: input.triggeringUserId ?? null,
    manageTaskStatus: input.manageTaskStatus,
    status: 'in_flight',
    agentActed: false,
    createdAt: Date.now(),
  }).run();
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
  db.update(taskRuns)
    .set({ status, completedAt: Date.now() })
    .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'in_flight')))
    .run();
}

/** Time out runs still in flight after maxAgeMs; returns the timed-out rows. */
export function sweepStaleRuns(maxAgeMs: number): TaskRun[] {
  const cutoff = Date.now() - maxAgeMs;
  const stale = db.select().from(taskRuns)
    .where(and(eq(taskRuns.status, 'in_flight'), lt(taskRuns.createdAt, cutoff)))
    .all();
  if (stale.length === 0) return [];
  db.update(taskRuns)
    .set({ status: 'timed_out', completedAt: Date.now() })
    .where(inArray(taskRuns.id, stale.map(r => r.id)))
    .run();
  return stale;
}
