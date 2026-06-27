// Pending chore casts: the propose → approve state machine for `approval: cast`
// (and the fail-safe path when a step can't be confidently cast under `approval:
// auto`). Mirrors lib/self-changes.ts — the cast comment's discussion id is the
// lookup key for the human's "approve"/"reject" reply; same-(chore,page) pending
// rows are superseded so a cast can never double-apply; stale casts expire.

import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingChoreCasts } from '../db/schema.js';
import { parseApprovalReply } from '../lib/self-changes.js';
import type { ChoreCastPayload, ChoreDoc, ResolvedCastStep } from './types.js';

export type PendingChoreCast = typeof pendingChoreCasts.$inferSelect;
export { parseApprovalReply };

const PENDING_TTL_MS = 7 * 24 * 3600_000;

/** Park a resolved cast for approval (superseding an older pending cast for the
 * same chore on the same page). Returns the row. */
export function createPendingCast(args: {
  choreId: string;
  sourcePageId: string;
  payload: ChoreCastPayload;
  castText: string;
  pageId: string;
  proposedByUserId?: string | null;
}): PendingChoreCast {
  db.update(pendingChoreCasts)
    .set({ status: 'superseded', resolvedAt: Date.now() })
    .where(and(
      eq(pendingChoreCasts.choreId, args.choreId),
      eq(pendingChoreCasts.sourcePageId, args.sourcePageId),
      eq(pendingChoreCasts.status, 'pending'),
    ))
    .run();
  const id = randomUUID();
  db.insert(pendingChoreCasts).values({
    id,
    choreId: args.choreId,
    sourcePageId: args.sourcePageId,
    payloadJson: JSON.stringify(args.payload),
    castText: args.castText,
    status: 'pending',
    pageId: args.pageId,
    proposedByUserId: args.proposedByUserId ?? null,
    createdAt: Date.now(),
  }).run();
  return db.select().from(pendingChoreCasts).where(eq(pendingChoreCasts.id, id)).all()[0]!;
}

/** Record where the cast comment landed (the thread to watch for the verdict). */
export function attachCastComment(id: string, commentId: string, discussionId: string | null): void {
  db.update(pendingChoreCasts)
    .set({ proposedCommentId: commentId, discussionId })
    .where(eq(pendingChoreCasts.id, id))
    .run();
}

/** The pending cast whose proposal lives in this discussion thread, if any. */
export function findPendingCastByDiscussion(discussionId: string): PendingChoreCast | null {
  const rows = db.select().from(pendingChoreCasts)
    .where(and(eq(pendingChoreCasts.discussionId, discussionId), eq(pendingChoreCasts.status, 'pending')))
    .all();
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Close a pending cast with the human's verdict. */
export function resolveCast(id: string, status: 'approved' | 'rejected', byUserId: string | null): void {
  db.update(pendingChoreCasts)
    .set({ status, resolvedAt: Date.now(), resolvedByUserId: byUserId })
    .where(eq(pendingChoreCasts.id, id))
    .run();
}

/** Parse a stored cast payload. */
export function readCastPayload(row: PendingChoreCast): ChoreCastPayload {
  return JSON.parse(row.payloadJson) as ChoreCastPayload;
}

/** Expire pending casts older than the TTL. Returns how many were expired. */
export function expireStaleCasts(ttlMs = PENDING_TTL_MS): number {
  const res = db.update(pendingChoreCasts)
    .set({ status: 'expired', resolvedAt: Date.now() })
    .where(and(eq(pendingChoreCasts.status, 'pending'), lt(pendingChoreCasts.createdAt, Date.now() - ttlMs)))
    .run();
  return Number(res.changes ?? 0);
}

/** Render the cast as a human-readable approval comment (also stored as castText). */
export function renderCast(chore: ChoreDoc, cast: ResolvedCastStep[]): string {
  const lines = cast.map(c => {
    const step = chore.steps.find(s => s.index === c.stepIndex);
    const label = step ? `${step.number}. ${step.title || step.needs}` : `step ${c.number}`;
    const who = c.agentName ? `@${c.agentName} (${c.confidence.toFixed(2)})` : '(no match — please assign)';
    return `${label} · ${c.capability} · ${who}`;
  });
  const allResolved = cast.every(c => c.agentName);
  return [
    `🧭 **NORC** — proposed plan for the “${chore.id}” process:`,
    ...lines.map(l => `• ${l}`),
    ``,
    allResolved
      ? `Reply **approve** to run it, or **reject** to discard.`
      : `Some steps have no confident match — assign them in Notion, then reply **approve**, or **reject** to discard.`,
  ].join('\n');
}
