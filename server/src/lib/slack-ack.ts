// "Received" acknowledgement for inbound Slack mentions. Tagging an agent kicks
// off triage + routing (an LLM round-trip) before NORC posts anything, so the
// human is left wondering whether the message even landed. We bridge that gap
// with an emoji reaction: ⏳ the instant we recognise the message is for us,
// swapped to ✅ once NORC/the agent has responded in the thread.
//
// Kept dependency-light (only slack-client) so BOTH the inbound orchestrator and
// the async completion path (orchestrator.ts finalizeAgentReport) can import it
// without the slack-orchestrator import cycle. Resolution is keyed by the thread
// (channel + thread root) — the one handle both the synchronous lanes and the
// async Agent-API reply share — while the reaction itself lands on the precise
// triggering message.

import { addReaction, removeReaction } from './slack-client.js';

const PENDING_EMOJI = 'hourglass_flowing_sand'; // ⏳
const DONE_EMOJI = 'white_check_mark';          // ✅

interface PendingAck {
  channel: string;
  /** The exact message the ⏳ sits on (a thread reply differs from its root). */
  messageTs: string;
  /** Resolves true once the ⏳ actually landed — so we don't remove a reaction
   *  that was never added (which would leave a stuck ⏳ on a scope/timing race). */
  added: Promise<boolean>;
}

// In-memory only: an ack resolves within seconds of the message, so losing the
// map across a restart just means a ⏳ is never swapped — cosmetic, self-heals
// on the next message. Keyed by `${channel}:${threadRoot}`.
const pending = new Map<string, PendingAck>();

function key(channel: string, threadRoot: string): string {
  return `${channel}:${threadRoot}`;
}

async function flip(token: string, ack: PendingAck, to: string): Promise<void> {
  const landed = await ack.added.catch(() => false);
  if (landed) await removeReaction(token, ack.channel, ack.messageTs, PENDING_EMOJI).catch(() => {});
  await addReaction(token, ack.channel, ack.messageTs, to).catch(() => {});
}

/**
 * Mark a triggering message as received — fires ⏳ immediately and records it so
 * a later {@link ackResolved} can swap it. Non-blocking: the reaction request is
 * dispatched but never awaited here, so it adds no latency before triage.
 */
export function ackReceived(token: string, channel: string, threadRoot: string, messageTs: string): void {
  if (!token) return;
  const k = key(channel, threadRoot);
  // A second message in the same thread before the first flipped: tidy the old
  // ⏳ to ✅ rather than abandon it (rare — the window is seconds wide).
  const prior = pending.get(k);
  if (prior) void flip(token, prior, DONE_EMOJI);
  const added = addReaction(token, channel, messageTs, PENDING_EMOJI).then(() => true, () => false);
  pending.set(k, { channel, messageTs, added });
}

/**
 * Swap a thread's pending ⏳ for ✅ once NORC/the agent has responded. No-op when
 * nothing is pending (already resolved, or the message was never acked), so it's
 * safe to call from every conclusion point — sync reply, task hand-off, async
 * completion, timeout.
 */
export async function ackResolved(token: string, channel: string, threadRoot: string): Promise<void> {
  const k = key(channel, threadRoot);
  const ack = pending.get(k);
  if (!ack) return;
  pending.delete(k);
  if (!token) return;
  await flip(token, ack, DONE_EMOJI);
}

/** Test-only: drop all pending marks. */
export function _resetAcks(): void {
  pending.clear();
}
