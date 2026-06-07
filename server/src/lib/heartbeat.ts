// Heartbeat — periodic agent liveness, two layers:
//   • Transport heartbeat (runHeartbeat): cheap reachability ping for every
//     registered agent, records agents.status / lastPingedAt / lastLatencyMs and
//     reflects it on the agent's Notion Org DB Status (reachable → Available,
//     unreachable → Offline).
//   • Deep heartbeat (runDeepHeartbeat): a real test prompt sent through the
//     agent's AI stack via the dispatch path — catches "gateway reachable but AI
//     credentials broken", which a transport ping can't see.
// Outage tracking keeps two consecutive-failure counters per agent (a transport
// success must not reset the deep counter — only a real reply proves the whole
// path). When max(counters) reaches the configured threshold, the agent's Org DB
// Owner is @mentioned once per outage; recovery posts a plain follow-up comment.
// Neither layer ever touches an agent that is mid-task (an in-flight run) or one
// a human has marked Busy, so it can't clobber real work.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration, orchestratorComments } from '../db/schema.js';
import { pingAgent, dispatch, dispatchSupported, type DispatchResult } from '../adapters/index.js';
import { setAgentStatus, touchLastActive, postComment, postCommentRich } from './notion-writeback.js';
import { notionGet } from './notion-client.js';
import { getSelect, getPeople } from './notion-props.js';
import { getNorcSettingsOrDefault } from './norc-settings.js';
import { hasInFlightRun } from './runs.js';
import { emitLog } from './logger.js';
import { emitEvent } from './events.js';
import type { Agent, AdapterType, AgentStatus } from '../types.js';

const CONCURRENCY = 4;

const DEEP_PING_PROMPT = 'NORC health check: reply with the single word "OK".';
const DEEP_CAPTURE_MS = 30_000;   // openclaw reply-capture window for healthchecks (vs 120s for tasks)
const DEEP_HARD_CAP_MS = 35_000;  // outer race so no adapter can stall a deep tick

/** Ping every agent, update local + Notion status. Returns how many were checked. */
export async function runHeartbeat(): Promise<{ checked: number }> {
  const rows = db.select().from(agents).all();
  if (rows.length === 0) return { checked: 0 };

  const apiKey = activeNotionKey();

  let checked = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async row => {
      let config: Record<string, unknown>;
      try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }
      const agent: Agent = {
        id: row.id, name: row.name, adapterType: row.adapterType as AdapterType,
        adapterConfig: config, status: row.status as AgentStatus,
        lastPingedAt: row.lastPingedAt ?? null, lastLatencyMs: row.lastLatencyMs ?? null,
        registeredAt: row.registeredAt, metadata: {},
      };

      const result = await pingAgent(agent);
      const status: AgentStatus = result.ok ? 'connected' : 'unreachable';
      const now = Date.now();
      db.update(agents).set({ status, lastPingedAt: now, lastLatencyMs: result.latencyMs })
        .where(eq(agents.id, row.id)).run();
      emitEvent({ type: 'agent.updated', data: { id: row.id, status, lastPingedAt: now, lastLatencyMs: result.latencyMs } });

      await trackCheckOutcome(row.id, 'transport', result.ok, apiKey);

      // Reflect on Notion — but never override a working/Busy agent.
      if (apiKey && row.orgDbPageId && !hasInFlightRun(row.id)) {
        await reflectOrgDbStatus(apiKey, row.orgDbPageId, result.ok);
      }
      checked++;
    }));
  }

  emitLog(`heartbeat: checked ${checked} agent(s)`);
  return { checked };
}

/**
 * Send a real test prompt through each agent's AI stack. Pass = a non-empty
 * reply; an error or a bare ACK with no captured text ({async}) = fail. Busy
 * agents are skipped entirely (no prompt injected, no counter change), as are
 * adapters without a dispatch implementation.
 */
export async function runDeepHeartbeat(): Promise<{ checked: number; failed: number; skipped: number }> {
  const rows = db.select().from(agents).all();
  if (rows.length === 0) return { checked: 0, failed: 0, skipped: 0 };

  const apiKey = activeNotionKey();

  let checked = 0, failed = 0, skipped = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async row => {
      if (hasInFlightRun(row.id) || !dispatchSupported(row.adapterType as AdapterType)) { skipped++; return; }

      let config: Record<string, unknown>;
      try { config = JSON.parse(row.adapterConfig); } catch { config = {}; }

      const start = Date.now();
      const result = await withTimeout(dispatch({
        adapterType: row.adapterType as AdapterType, config,
        system: '', prompt: DEEP_PING_PROMPT, agentName: row.name,
        sessionKind: 'healthcheck', captureMs: DEEP_CAPTURE_MS,
      }), DEEP_HARD_CAP_MS).catch((err: unknown): DispatchResult =>
        ({ ok: false, supported: true, error: err instanceof Error ? err.message : 'deep ping failed' }));

      const ok = result.ok && !result.async && !!result.text?.trim();
      const now = Date.now();
      const status: AgentStatus = ok ? 'connected' : 'unreachable';
      db.update(agents).set({ status, lastPingedAt: now, lastLatencyMs: now - start })
        .where(eq(agents.id, row.id)).run();
      emitEvent({ type: 'agent.updated', data: { id: row.id, status, lastPingedAt: now, lastLatencyMs: now - start } });

      await trackCheckOutcome(row.id, 'deep', ok, apiKey);

      if (apiKey && row.orgDbPageId && !hasInFlightRun(row.id)) {
        await reflectOrgDbStatus(apiKey, row.orgDbPageId, ok);
      }
      checked++;
      if (!ok) {
        failed++;
        emitLog(`deep heartbeat: "${row.name}" failed — ${result.error ?? (result.async ? 'no reply captured' : 'empty reply')}`);
      }
    }));
  }

  emitLog(`deep heartbeat: ${checked} checked, ${failed} failed, ${skipped} skipped (busy/unsupported)`);
  return { checked, failed, skipped };
}

/**
 * Consecutive-failure bookkeeping shared by both heartbeat layers. A transport
 * success resets only the transport counter (a reachable gateway doesn't prove
 * working AI); a deep success resets both. Crossing the configured threshold
 * notifies the agent's Org DB Owner once per outage; recovery posts a follow-up.
 */
async function trackCheckOutcome(
  agentId: string,
  kind: 'transport' | 'deep',
  ok: boolean,
  apiKey: string | null,
): Promise<void> {
  // Re-read the row: the transport and deep loops run on independent timers.
  const row = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!row) return;
  const settings = getNorcSettingsOrDefault();
  const now = Date.now();

  if (ok) {
    // With deep pings off, a transport success is the strongest signal we get —
    // let it clear the deep counter too so an old outage can't linger forever.
    const deepAuthoritative = kind === 'deep' || !(settings.heartbeatEnabled && settings.deepPingEnabled);
    const deepFailures = deepAuthoritative ? 0 : row.deepFailures;
    const patch: Partial<typeof agents.$inferInsert> = { transportFailures: 0, deepFailures, lastOkAt: now };
    if (row.upSinceAt == null) patch.upSinceAt = now;

    if (row.downNotifiedAt != null && deepFailures === 0) {
      // Recovery — confirmed up after a notified outage.
      const downFor = row.lastOkAt != null ? humanizeDuration(now - row.lastOkAt) : null;
      const text = `Heartbeat: "${row.name}" is back up${downFor ? ` — it was down for ${downFor}` : ''}.`;
      emitLog(text);
      if (apiKey && row.orgDbPageId) {
        try {
          const { commentId } = await postComment(apiKey, row.orgDbPageId, text);
          recordOurComment(commentId);
        } catch { /* best-effort: the agent IS up; state resets regardless */ }
      }
      patch.downNotifiedAt = null;
      patch.upSinceAt = now;
    }
    db.update(agents).set(patch).where(eq(agents.id, row.id)).run();
    return;
  }

  const transportFailures = kind === 'transport' ? row.transportFailures + 1 : row.transportFailures;
  const deepFailures = kind === 'deep' ? row.deepFailures + 1 : row.deepFailures;
  const patch: Partial<typeof agents.$inferInsert> = { transportFailures, deepFailures };

  const failures = Math.max(transportFailures, deepFailures);
  const threshold = Math.max(1, settings.failureNotifyThreshold);
  if (failures >= threshold && row.downNotifiedAt == null) {
    // Mark notified only when the post lands (or there's nowhere to post), so a
    // transient Notion failure retries next tick — exactly one comment per outage.
    if (await postDownNotification(apiKey, row, failures, kind)) patch.downNotifiedAt = now;
  }
  db.update(agents).set(patch).where(eq(agents.id, row.id)).run();
}

/**
 * Comment on the agent's Org DB page that it appears down, @mentioning its
 * Owner (people property) when one is set. Returns true when posted or when
 * there is nowhere to post; false on a Notion error (caller retries next tick).
 */
async function postDownNotification(
  apiKey: string | null,
  row: { name: string; orgDbPageId: string | null; upSinceAt: number | null; lastOkAt: number | null },
  failures: number,
  kind: 'transport' | 'deep',
): Promise<boolean> {
  const upFor = row.upSinceAt != null && row.lastOkAt != null && row.lastOkAt > row.upSinceAt
    ? humanizeDuration(row.lastOkAt - row.upSinceAt) : null;
  const text = `Heartbeat: "${row.name}" appears DOWN — ${failures} consecutive failed health checks (latest: ${kind} ping). ` +
    (upFor ? `It had been up for ${upFor}.` : 'It has not been seen up recently.');
  emitLog(text);
  if (!apiKey || !row.orgDbPageId) return true; // nowhere to post — acknowledge the outage so we don't spam later

  try {
    const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${row.orgDbPageId}`);
    const owners = getPeople(page['properties'], 'Owner');
    const owner = owners[0];
    const { commentId } = owner
      ? await postCommentRich(apiKey, row.orgDbPageId, [{ userId: owner }, ` ${text}`])
      : await postComment(apiKey, row.orgDbPageId, text);
    recordOurComment(commentId);
    return true;
  } catch (err) {
    emitLog(`heartbeat: failed to post down notification for "${row.name}": ${err instanceof Error ? err.message : 'unknown'}`);
    return false;
  }
}

/** Set Org DB Status to Available/Offline, skipping Busy and no-op writes. */
async function reflectOrgDbStatus(apiKey: string, orgDbPageId: string, reachable: boolean): Promise<void> {
  try {
    const page = await notionGet<Record<string, unknown>>(apiKey, `/pages/${orgDbPageId}`);
    const current = getSelect(page['properties'], 'Status');
    if (current === 'Busy') return; // don't disturb a working agent
    if (reachable) {
      if (current !== 'Available') await setAgentStatus(apiKey, orgDbPageId, 'Available');
      await touchLastActive(apiKey, orgDbPageId);
    } else if (current !== 'Offline') {
      await setAgentStatus(apiKey, orgDbPageId, 'Offline');
    }
  } catch {
    // best-effort: a Notion read/write failure shouldn't break the heartbeat
  }
}

/** The active Notion integration's api key, or null. */
function activeNotionKey(): string | null {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  return integration && integration.status === 'active' ? integration.apiKey : null;
}

/** Record a NORC-authored comment id so the comment webhook ignores it (loop prevention). */
function recordOurComment(commentId: string): void {
  if (commentId) {
    db.insert(orchestratorComments).values({ commentId, createdAt: Date.now() }).onConflictDoNothing().run();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

/** "3d 4h" | "2h 15m" | "12m" | "under a minute" */
function humanizeDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'under a minute';
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
