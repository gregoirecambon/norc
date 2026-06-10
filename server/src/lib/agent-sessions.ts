// Session memory — "session-per-anchor + context fingerprint". An agent's session
// is keyed to (agent, anchor page, lane) and reused while its context fingerprint is
// unchanged; when the durable framing changes (system prompt, project/strategic
// context, clearance), the session is REBUILT — a fresh session key (epoch++) so the
// agent starts clean instead of carrying stale memory. Only session-capable adapters
// keep server-side memory; stateless ones re-assemble the full prompt every turn and
// need no bookkeeping.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { AdapterType } from '../types.js';

/** Adapters that retain server-side memory across turns (so reuse-vs-rebuild
 * actually matters). Everything else re-assembles clean each turn. Today only
 * OpenClaw; extend this set as session-capable adapters are added. */
const SESSION_CAPABLE = new Set<AdapterType>(['openclaw']);

/** The bare per-anchor key, before any epoch suffix. Must match the historical
 * sessionId so existing OpenClaw sessions aren't orphaned on first deploy. */
function baseSessionId(pageId: string, lane: 'work' | 'chat'): string {
  return lane === 'chat' ? `${pageId}#chat` : pageId;
}

export interface ResolvedSession {
  /** The session id to dispatch under (page / page#chat / page#g2). */
  sessionId: string;
  /** True when an existing session was reused (fingerprint unchanged). */
  reused: boolean;
}

/**
 * Decide which session a turn should address, and persist the decision.
 *
 * - Session-incapable adapter → the bare base id, no row written (clean each turn).
 * - First contact → the bare base id, epoch 1 (don't orphan a pre-existing session).
 * - Fingerprint unchanged → reuse the stored session id.
 * - Fingerprint changed → epoch++ and a fresh `${base}#g${epoch}` session id.
 *
 * Epoch is monotonic per (agent, page, lane): a changed-then-reverted fingerprint
 * still advances to a new `#gN`, so a poisoned session is never re-entered.
 */
export function resolveSession(args: {
  agentId: string;
  pageId: string;
  lane: 'work' | 'chat';
  fingerprint: string;
  adapterType: AdapterType;
}): ResolvedSession {
  const base = baseSessionId(args.pageId, args.lane);
  if (!SESSION_CAPABLE.has(args.adapterType)) return { sessionId: base, reused: false };

  const now = Date.now();
  const existing = db.select().from(agentSessions)
    .where(and(
      eq(agentSessions.agentId, args.agentId),
      eq(agentSessions.pageId, args.pageId),
      eq(agentSessions.lane, args.lane),
    ))
    .all()[0];

  if (!existing) {
    db.insert(agentSessions).values({
      id: randomUUID(),
      agentId: args.agentId,
      pageId: args.pageId,
      lane: args.lane,
      sessionId: base,
      fingerprint: args.fingerprint,
      epoch: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    return { sessionId: base, reused: false };
  }

  if (existing.fingerprint === args.fingerprint) {
    db.update(agentSessions).set({ updatedAt: now }).where(eq(agentSessions.id, existing.id)).run();
    return { sessionId: existing.sessionId, reused: true };
  }

  const epoch = existing.epoch + 1;
  const sessionId = `${base}#g${epoch}`;
  db.update(agentSessions)
    .set({ sessionId, fingerprint: args.fingerprint, epoch, updatedAt: now })
    .where(eq(agentSessions.id, existing.id))
    .run();
  return { sessionId, reused: false };
}
