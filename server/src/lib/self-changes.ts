// NORC self-modification: the propose → approve state machine. A
// propose_self_change action parks the change here with a rendered before→after
// diff; the proposal comment's discussion id is the lookup key for the human's
// verdict reply ("approve"/"reject") in that thread. Same-kind pending rows are
// superseded by newer proposals so a change can never double-apply; stale
// proposals expire after 7 days.

import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingSelfChanges } from '../db/schema.js';
import { getNorcSettingsOrDefault, upsertNorcSettings } from './norc-settings.js';
import { notionPatch } from './notion-client.js';
import { toRichText } from './notion-writeback.js';
import { getNorcOrgPageId } from './norc-identity.js';
import { type SelfChangeKind } from './norc-agent.js';

export type PendingSelfChange = typeof pendingSelfChanges.$inferSelect;

const DIFF_MAX_CHARS = 1500;
const PENDING_TTL_MS = 7 * 24 * 3600_000;

/** Park a proposed change (superseding any older pending change of the same kind). */
export function createPendingChange(args: {
  kind: SelfChangeKind;
  payload: Record<string, unknown>;
  diffText: string;
  pageId: string;
  proposedByUserId?: string | null;
}): PendingSelfChange {
  db.update(pendingSelfChanges)
    .set({ status: 'superseded', resolvedAt: Date.now() })
    .where(and(eq(pendingSelfChanges.kind, args.kind), eq(pendingSelfChanges.status, 'pending')))
    .run();
  const id = randomUUID();
  db.insert(pendingSelfChanges).values({
    id,
    kind: args.kind,
    payloadJson: JSON.stringify(args.payload),
    diffText: args.diffText,
    status: 'pending',
    pageId: args.pageId,
    proposedByUserId: args.proposedByUserId ?? null,
    createdAt: Date.now(),
  }).run();
  return db.select().from(pendingSelfChanges).where(eq(pendingSelfChanges.id, id)).all()[0]!;
}

/** Record where the proposal comment landed (the thread to watch for a verdict). */
export function attachProposalComment(id: string, commentId: string, discussionId: string | null): void {
  db.update(pendingSelfChanges)
    .set({ proposedCommentId: commentId, discussionId })
    .where(eq(pendingSelfChanges.id, id))
    .run();
}

/** The pending change whose proposal lives in this discussion thread, if any.
 * Newest first, in case several proposals landed in one thread. */
export function findPendingByDiscussion(discussionId: string): PendingSelfChange | null {
  const rows = db.select().from(pendingSelfChanges)
    .where(and(eq(pendingSelfChanges.discussionId, discussionId), eq(pendingSelfChanges.status, 'pending')))
    .all();
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Close a pending change with the human's verdict. */
export function resolveChange(id: string, status: 'approved' | 'rejected', byUserId: string | null): void {
  db.update(pendingSelfChanges)
    .set({ status, resolvedAt: Date.now(), resolvedByUserId: byUserId })
    .where(eq(pendingSelfChanges.id, id))
    .run();
}

/** Expire pending changes older than the TTL. Returns how many were expired. */
export function expireStaleChanges(ttlMs = PENDING_TTL_MS): number {
  const res = db.update(pendingSelfChanges)
    .set({ status: 'expired', resolvedAt: Date.now() })
    .where(and(eq(pendingSelfChanges.status, 'pending'), lt(pendingSelfChanges.createdAt, Date.now() - ttlMs)))
    .run();
  return Number(res.changes ?? 0);
}

/** Classify a reply in a proposal thread. Both/neither keyword → 'unclear'
 * (the change stays pending and NORC asks for an explicit verdict). */
export function parseApprovalReply(text: string): 'approve' | 'reject' | 'unclear' {
  const approve = /\b(approve[ds]?|lgtm)\b/i.test(text) || text.includes('✅') || /\b(approuv[ée]?s?)\b/i.test(text);
  const reject = /\b(reject(s|ed)?|deny|denied|cancel(led)?|refuse[rd]?s?)\b/i.test(text) || text.includes('❌');
  if (approve === reject) return 'unclear';
  return approve ? 'approve' : 'reject';
}

/** Human-readable before→after block for the proposal comment (audit trail). */
export function renderSelfChangeDiff(kind: SelfChangeKind, before: string, after: string): string {
  const clip = (s: string) => {
    const t = s.trim() || '(not set)';
    return t.length > DIFF_MAX_CHARS ? `${t.slice(0, DIFF_MAX_CHARS)}…(truncated)` : t;
  };
  return [`change: ${kind}`, `— before —`, clip(before), ``, `— after —`, clip(after)].join('\n');
}

/** What a change would set, as display strings — used for both the diff and apply. */
export function describeCurrentValue(kind: SelfChangeKind): string {
  const s = getNorcSettingsOrDefault();
  switch (kind) {
    case 'orchestratorSystemPrompt': return s.orchestratorSystemPrompt ?? '(default prompt)';
    case 'autoRouteThreshold': return String(s.autoRouteThreshold);
    case 'autoProposeEnabled': return String(s.autoProposeEnabled);
    case 'autoProposeIntervalHours': return String(s.autoProposeIntervalHours);
    case 'norcOrgPage': return '(current Org DB profile)';
  }
}

/** Render the proposed payload as the "after" side of the diff. */
export function describeProposedValue(kind: SelfChangeKind, payload: Record<string, unknown>): string {
  if (kind === 'norcOrgPage') {
    const parts: string[] = [];
    if (typeof payload['specialty'] === 'string') parts.push(`Specialty: ${payload['specialty']}`);
    if (typeof payload['systemPrompt'] === 'string') parts.push(`System Prompt: ${payload['systemPrompt']}`);
    return parts.join('\n') || '(no fields)';
  }
  return String(payload['value'] ?? '(missing value)');
}

/**
 * Apply an approved change. Validation mirrors routes/settings.ts (thresholds
 * clamped, hours bounded); an invalid payload throws and the change stays
 * pending so the human sees the error and can re-propose.
 */
export async function applySelfChange(apiKey: string, change: PendingSelfChange): Promise<string> {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(change.payloadJson) as Record<string, unknown>; }
  catch { throw new Error('unreadable change payload'); }
  const kind = change.kind as SelfChangeKind;

  switch (kind) {
    case 'orchestratorSystemPrompt': {
      const value = typeof payload['value'] === 'string' ? payload['value'].trim() : null;
      if (value === null) throw new Error('orchestratorSystemPrompt needs a string "value"');
      upsertNorcSettings({ orchestratorSystemPrompt: value || null });
      return value ? 'my system prompt is updated' : 'my system prompt is reset to the default';
    }
    case 'autoRouteThreshold': {
      const raw = typeof payload['value'] === 'number' ? payload['value'] : NaN;
      if (!Number.isFinite(raw)) throw new Error('autoRouteThreshold needs a numeric "value"');
      const value = Math.max(0, Math.min(1, raw));
      upsertNorcSettings({ autoRouteThreshold: value });
      return `autoRouteThreshold is now ${value}`;
    }
    case 'autoProposeEnabled': {
      if (typeof payload['value'] !== 'boolean') throw new Error('autoProposeEnabled needs a boolean "value"');
      upsertNorcSettings({ autoProposeEnabled: payload['value'] });
      return `auto-propose is now ${payload['value'] ? 'ON' : 'OFF'}`;
    }
    case 'autoProposeIntervalHours': {
      const raw = typeof payload['value'] === 'number' ? payload['value'] : NaN;
      if (!Number.isFinite(raw)) throw new Error('autoProposeIntervalHours needs a numeric "value"');
      const value = Math.max(1, Math.min(24, Math.floor(raw)));
      upsertNorcSettings({ autoProposeIntervalHours: value });
      return `auto-propose now runs every ${value}h`;
    }
    case 'norcOrgPage': {
      const pageId = getNorcOrgPageId();
      if (!pageId) throw new Error('NORC has no Org DB page yet');
      const properties: Record<string, unknown> = {};
      if (typeof payload['specialty'] === 'string') properties['Specialty'] = { rich_text: toRichText(payload['specialty'].slice(0, 2000)) };
      if (typeof payload['systemPrompt'] === 'string') properties['System Prompt'] = { rich_text: toRichText(payload['systemPrompt'].slice(0, 2000)) };
      if (Object.keys(properties).length === 0) throw new Error('norcOrgPage needs "specialty" and/or "systemPrompt"');
      await notionPatch(apiKey, `/pages/${pageId}`, { properties });
      return 'my Org DB profile is updated';
    }
    default:
      throw new Error(`unknown change kind "${change.kind}"`);
  }
}
