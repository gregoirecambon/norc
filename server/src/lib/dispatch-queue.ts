// The dispatch queue — durable holding pen for agent turns that couldn't run
// immediately (the agent is at its maxConcurrentRuns cap, or already has an
// in-flight run on the same project/page). Pure DB module: storage, eligibility
// and the claim primitive live here; the orchestrator owns enqueue decisions
// and the drain loop. NEVER import the orchestrator from this file.
//
// Ordering: priority first (desc — out-of-band/external work jumps ahead),
// then FIFO per agent with overtake — an item blocked by its project/page
// conflict is skipped (and its project/page blocks everything younger in the
// same project/page), while younger items from other projects may run. This
// keeps the user's hard rule (same-project tasks run strictly one after the
// other) without head-of-line blocking the whole agent.

import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dispatchQueue } from '../db/schema.js';
import { emitEvent } from './events.js';
import { emitLog } from './logger.js';
import { activeRunCount, hasRunConflict } from './runs.js';

export type DispatchQueueRow = typeof dispatchQueue.$inferSelect;

/** The serialized turn — TurnOpts minus the comment thread (re-fetched fresh at
 * drain time via threadBlockId ?? pageId, so the agent sees the latest state). */
export interface QueuedTurn {
  request: string;
  triggeringCommentId?: string;
  discussionId?: string | null;
  commentedText?: string;
  triggeringUserId?: string | null;
  manageTaskStatus: boolean;
  how: string;
  /** Where the triggering comment's thread lives (a block id for inline comments). */
  threadBlockId?: string;
  /** Slack origin — carried across the queue so a drained run still reports
   * back to the originating Slack thread. */
  slackChannel?: string | null;
  slackThreadTs?: string | null;
  triggeringSlackUserId?: string | null;
  /** Auto-routed by triage — carried so the drained run keeps its TRIAGE flag. */
  viaTriage?: boolean;
}

function emitQueueUpdated(agentId: string): void {
  emitEvent({ type: 'queue.updated', data: { agentId, pending: pendingCount(agentId) } });
}

export function enqueueTurn(input: {
  agentId: string;
  pageId: string;
  taskPageId: string | null;
  projectId: string | null;
  anchorKind: string;
  title: string | null;
  payload: QueuedTurn;
  /** Higher drains first (default 0; 1 = out-of-band/external priority work). */
  priority?: number;
}): { id: number; position: number } {
  const result = db.insert(dispatchQueue).values({
    agentId: input.agentId,
    pageId: input.pageId,
    taskPageId: input.taskPageId,
    projectId: input.projectId,
    anchorKind: input.anchorKind,
    title: input.title,
    payload: JSON.stringify(input.payload),
    priority: input.priority ?? 0,
    status: 'pending',
    enqueuedAt: Date.now(),
  }).run();
  const id = Number(result.lastInsertRowid);
  // Position in DRAIN order (priority desc, then FIFO) — a priority item lands
  // ahead of normal work, so the tail count would lie to the user.
  const position = pendingItems(input.agentId).findIndex(r => r.id === id) + 1;
  emitQueueUpdated(input.agentId);
  return { id, position };
}

export function pendingCount(agentId: string): number {
  return db.select().from(dispatchQueue)
    .where(and(eq(dispatchQueue.agentId, agentId), eq(dispatchQueue.status, 'pending')))
    .all().length;
}

/** Pending items in drain order (priority desc, then oldest first) — for one
 * agent or (dashboard) all agents. */
export function pendingItems(agentId?: string): DispatchQueueRow[] {
  const cond = agentId
    ? and(eq(dispatchQueue.agentId, agentId), eq(dispatchQueue.status, 'pending'))
    : eq(dispatchQueue.status, 'pending');
  return db.select().from(dispatchQueue).where(cond)
    .orderBy(desc(dispatchQueue.priority), asc(dispatchQueue.id)).all();
}

/** Distinct agent ids with pending work — drained at boot and by the sweep. */
export function agentsWithPending(): string[] {
  return [...new Set(pendingItems().map(r => r.agentId))];
}

/**
 * The first pending item (in drain order: priority desc, then FIFO) this agent
 * could run RIGHT NOW (peek — no claim). Blocked sets are seeded from the
 * agent's in-flight work runs; a skipped item's project/page joins the set, so
 * ordering stays strict within a project while other projects' items may
 * overtake.
 */
export function nextEligible(agentId: string): DispatchQueueRow | null {
  const blockedProjects = new Set<string>();
  const blockedPages = new Set<string>();
  for (const item of pendingItems(agentId)) {
    const projectBlocked = item.projectId !== null && blockedProjects.has(item.projectId);
    const pageBlocked = blockedPages.has(item.pageId);
    if (projectBlocked || pageBlocked || hasRunConflict(agentId, item.projectId, item.pageId)) {
      if (item.projectId !== null) blockedProjects.add(item.projectId);
      blockedPages.add(item.pageId);
      continue;
    }
    return item;
  }
  return null;
}

/**
 * Atomically claim a pending item for dispatch — re-verifying capacity and
 * conflicts in the SAME synchronous tick. The caller must mint the run before
 * its next await; that's what makes the cap and the one-per-project rule hold
 * even with webhook turns and drains interleaving.
 */
export function claimAndCheck(itemId: number, agentId: string, projectId: string | null, pageId: string, maxConcurrent: number): boolean {
  if (activeRunCount(agentId) >= maxConcurrent) return false;
  if (hasRunConflict(agentId, projectId, pageId)) return false;
  const result = db.update(dispatchQueue)
    .set({ status: 'dispatched', dispatchedAt: Date.now() })
    .where(and(eq(dispatchQueue.id, itemId), eq(dispatchQueue.status, 'pending')))
    .run();
  if (result.changes === 0) return false;
  emitQueueUpdated(agentId);
  return true;
}

export function dropItem(itemId: number, reason: string): void {
  const row = db.select().from(dispatchQueue).where(eq(dispatchQueue.id, itemId)).all()[0];
  const result = db.update(dispatchQueue)
    .set({ status: 'dropped', droppedReason: reason, dispatchedAt: Date.now() })
    .where(and(eq(dispatchQueue.id, itemId), eq(dispatchQueue.status, 'pending')))
    .run();
  if (result.changes > 0 && row) {
    emitLog(`queue: dropped item ${itemId} (${reason}) for page ${row.pageId}`, 'NORC', row.pageId);
    emitQueueUpdated(row.agentId);
  }
}

/** Drop every pending item for (agent, page) — e.g. when a run on that page
 * timed out and escalation re-routes the work to a different agent. */
export function dropPendingForAgentPage(agentId: string, pageId: string, reason: string): number {
  const rows = db.select().from(dispatchQueue)
    .where(and(eq(dispatchQueue.agentId, agentId), eq(dispatchQueue.pageId, pageId), eq(dispatchQueue.status, 'pending')))
    .all();
  for (const row of rows) {
    db.update(dispatchQueue)
      .set({ status: 'dropped', droppedReason: reason, dispatchedAt: Date.now() })
      .where(eq(dispatchQueue.id, row.id))
      .run();
  }
  if (rows.length > 0) {
    emitLog(`queue: dropped ${rows.length} pending item(s) on page ${pageId} (${reason})`, 'NORC', pageId);
    emitQueueUpdated(agentId);
  }
  return rows.length;
}
