import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns } from '../db/schema.js';
import { onEvent, type NorcEvent } from '../lib/events.js';
import {
  createRun, touchRun, setOpenclawRunId, setRunSessionId, finalizeRun, findTimeoutCandidates, getRun,
  markRunTool, setRunTokens, pruneOldRuns, RUN_RETENTION_MS,
} from '../lib/runs.js';
import { RunTool } from '../lib/run-tools.js';

const IDLE = 300_000;        // 5 min silence window
const HARDCAP = 1_800_000;   // 30 min absolute ceiling

function addAgent(id = 'a1', name = 'alpha') {
  db.insert(agents).values({
    id, name, adapterType: 'openclaw', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1,
  }).run();
}

function newRun() {
  return createRun({ agentId: 'a1', pageId: 'p1', taskPageId: 'p1', anchorKind: 'task', manageTaskStatus: true });
}

/** Backdate createdAt / lastProgressAt to simulate an aged or silent run. */
function setTimes(id: string, opts: { createdAt?: number; lastProgressAt?: number | null }) {
  const patch: Record<string, unknown> = {};
  if (opts.createdAt !== undefined) patch['createdAt'] = opts.createdAt;
  if ('lastProgressAt' in opts) patch['lastProgressAt'] = opts.lastProgressAt;
  db.update(taskRuns).set(patch).where(eq(taskRuns.id, id)).run();
}

const candidate = (id: string) => findTimeoutCandidates(IDLE, HARDCAP).find(c => c.run.id === id);

beforeAll(() => { runMigrations(); });
beforeEach(() => {
  db.delete(taskRuns).run();
  db.delete(agents).run();
  addAgent();
});

describe('findTimeoutCandidates — idle window', () => {
  it('does NOT flag a run whose progress is recent (the false-kill bug)', () => {
    const { id } = newRun();
    // Old run overall, but the agent just called the API → still working.
    setTimes(id, { createdAt: Date.now() - (HARDCAP - 60_000), lastProgressAt: Date.now() });
    expect(candidate(id)).toBeUndefined();
  });

  it('flags a run that has been silent past the idle window', () => {
    const { id } = newRun();
    setTimes(id, { lastProgressAt: Date.now() - IDLE - 1_000 });
    expect(candidate(id)?.reason).toBe('idle');
  });

  it('touchRun clears an idle candidate (deadline extended)', () => {
    const { id } = newRun();
    setTimes(id, { lastProgressAt: Date.now() - IDLE - 1_000 });
    expect(candidate(id)).toBeTruthy();
    touchRun(id);
    expect(candidate(id)).toBeUndefined();
  });

  it('coalesces NULL lastProgressAt to createdAt (legacy rows)', () => {
    const { id } = newRun();
    setTimes(id, { createdAt: Date.now() - IDLE - 1_000, lastProgressAt: null });
    expect(candidate(id)?.reason).toBe('idle');
  });
});

describe('findTimeoutCandidates — hard cap', () => {
  it('flags a hard-capped run even when it is still actively reporting', () => {
    const { id } = newRun();
    setTimes(id, { createdAt: Date.now() - HARDCAP - 1_000, lastProgressAt: Date.now() });
    expect(candidate(id)?.reason).toBe('hardcap');
  });
});

describe('touchRun / finalizeRun guards', () => {
  it('touchRun is a no-op on a finalized run (no resurrection)', () => {
    const { id } = newRun();
    finalizeRun(id, 'done');
    const before = getRun(id)!.lastProgressAt;
    touchRun(id);
    expect(getRun(id)!.lastProgressAt).toBe(before);
  });

  it('finalizeRun returns true once, false on double-finalize, and emits exactly once', () => {
    const { id } = newRun();
    const seen: NorcEvent[] = [];
    const off = onEvent(e => { if (e.type === 'run.finished' && e.data.id === id) seen.push(e); });
    expect(finalizeRun(id, 'timed_out')).toBe(true);
    expect(finalizeRun(id, 'timed_out')).toBe(false);
    off();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Extract<NorcEvent, { type: 'run.finished' }>).data.status).toBe('timed_out');
  });
});

describe('setOpenclawRunId', () => {
  it('persists the OpenClaw run handle on an in-flight run', () => {
    const { id } = newRun();
    setOpenclawRunId(id, 'oc-run-9');
    expect(getRun(id)!.openclawRunId).toBe('oc-run-9');
  });

  it('does not write to a finalized run', () => {
    const { id } = newRun();
    finalizeRun(id, 'done');
    setOpenclawRunId(id, 'oc-run-9');
    expect(getRun(id)!.openclawRunId).toBeNull();
  });
});

describe('setRunSessionId', () => {
  it('records the session a run addressed', () => {
    const { id } = newRun();
    setRunSessionId(id, 'p1#g2');
    expect(getRun(id)!.sessionId).toBe('p1#g2');
  });

  it('persists even after the run is finalized (post-mortem debugging)', () => {
    const { id } = newRun();
    finalizeRun(id, 'failed');
    setRunSessionId(id, 'agent:alpha:norc:task:p1');
    expect(getRun(id)!.sessionId).toBe('agent:alpha:norc:task:p1');
  });
});

describe('toolFlags', () => {
  it('sets REMOTE_WORKER at mint time for an openclaw agent', () => {
    const { id } = newRun(); // addAgent() registers a1 as openclaw
    expect(getRun(id)!.toolFlags & RunTool.REMOTE_WORKER).toBeTruthy();
  });

  it('does NOT set REMOTE_WORKER for a local adapter', () => {
    db.insert(agents).values({
      id: 'a2', name: 'beta', adapterType: 'http', adapterConfig: '{}', status: 'untested',
      registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1,
    }).run();
    const { id } = createRun({ agentId: 'a2', pageId: 'p2', taskPageId: 'p2', anchorKind: 'task', manageTaskStatus: true });
    expect(getRun(id)!.toolFlags).toBe(0);
  });

  it('sets REMOTE_WORKER for a remote-claude-code agent regardless of adapter', () => {
    db.insert(agents).values({
      id: 'a3', name: 'gamma', adapterType: 'http', adapterConfig: '{}', status: 'untested',
      registeredAt: Date.now(), metadata: '{"kind":"remote-claude-code"}', maxConcurrentRuns: 1,
    }).run();
    const { id } = createRun({ agentId: 'a3', pageId: 'p3', taskPageId: 'p3', anchorKind: 'task', manageTaskStatus: true });
    expect(getRun(id)!.toolFlags & RunTool.REMOTE_WORKER).toBeTruthy();
  });

  it('sets SLACK at mint time for slack-origin runs', () => {
    const { id } = createRun({
      agentId: 'a1', pageId: 'p1', taskPageId: null, anchorKind: 'slack', manageTaskStatus: false,
      origin: 'slack', slackChannel: 'C1', slackThreadTs: '1.0', triggeringSlackUserId: 'U1',
    });
    const run = getRun(id)!;
    expect(run.toolFlags & RunTool.SLACK).toBeTruthy();
    expect(run.triggeringSlackUserId).toBe('U1');
  });

  it('markRunTool ORs bits in place without clobbering earlier ones', () => {
    const { id } = newRun();
    markRunTool(id, RunTool.PROPOSE_TASKS);
    markRunTool(id, RunTool.SLACK);
    markRunTool(id, RunTool.SLACK); // idempotent
    const flags = getRun(id)!.toolFlags;
    expect(flags & RunTool.PROPOSE_TASKS).toBeTruthy();
    expect(flags & RunTool.SLACK).toBeTruthy();
    expect(flags & RunTool.REMOTE_WORKER).toBeTruthy(); // from mint (openclaw)
  });

  it('mints with the TRIAGE flag when passed as initial toolFlags', () => {
    const { id } = createRun({
      agentId: 'a1', pageId: 'p1', taskPageId: 'p1', anchorKind: 'task', manageTaskStatus: true,
      toolFlags: RunTool.TRIAGE,
    });
    expect(getRun(id)!.toolFlags & RunTool.TRIAGE).toBeTruthy();
  });
});

describe('setRunTokens', () => {
  it('stores the agent-reported total, even after finalize (completion race)', () => {
    const { id } = newRun();
    finalizeRun(id, 'done');
    setRunTokens(id, 123_456);
    expect(getRun(id)!.tokensUsed).toBe(123_456);
  });
});

describe('pruneOldRuns — 90-day retention', () => {
  it('deletes finalized runs past retention, keeps recent and in-flight ones', () => {
    const old = newRun();
    finalizeRun(old.id, 'done');
    setTimes(old.id, { createdAt: Date.now() - RUN_RETENTION_MS - 1000 });

    const oldInFlight = createRun({ agentId: 'a1', pageId: 'p9', taskPageId: 'p9', anchorKind: 'task', manageTaskStatus: true });
    setTimes(oldInFlight.id, { createdAt: Date.now() - RUN_RETENTION_MS - 1000 });

    const recent = createRun({ agentId: 'a1', pageId: 'p8', taskPageId: 'p8', anchorKind: 'task', manageTaskStatus: true });
    finalizeRun(recent.id, 'done');

    expect(pruneOldRuns()).toBe(1);
    expect(getRun(old.id)).toBeNull();
    expect(getRun(oldInFlight.id)).not.toBeNull(); // never delete live work
    expect(getRun(recent.id)).not.toBeNull();
  });
});
