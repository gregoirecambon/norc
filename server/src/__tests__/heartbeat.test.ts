import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Stub the adapter layer so the heartbeat doesn't hit the network: an agent named
// "up" is transport-reachable, anything else is not. Deep-ping dispatch behavior
// is steered per test through the dispatch mock.
vi.mock('../adapters/index.js', () => ({
  pingAgent: vi.fn(async (agent: { name: string }) =>
    agent.name === 'up' ? { ok: true, latencyMs: 7 } : { ok: false, latencyMs: 0, error: 'down' }),
  dispatchSupported: vi.fn(() => true),
  dispatch: vi.fn(async () => ({ ok: true, supported: true, text: 'OK' })),
}));

import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { runHeartbeat, runDeepHeartbeat } from '../lib/heartbeat.js';
import { dispatch } from '../adapters/index.js';

const dispatchMock = vi.mocked(dispatch);

function addAgent(id: string, name: string) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}',
  }).run();
}

function getAgent(id: string) {
  return db.select().from(agents).where(eq(agents.id, id)).all()[0]!;
}

describe('runHeartbeat', () => {
  beforeAll(() => {
    runMigrations();
    addAgent('a1', 'up');
    addAgent('a2', 'down');
  });

  it('marks reachable agents connected and unreachable ones unreachable', async () => {
    const { checked } = await runHeartbeat();
    expect(checked).toBe(2);

    const up = getAgent('a1');
    const down = getAgent('a2');
    expect(up.status).toBe('connected');
    expect(up.lastLatencyMs).toBe(7);
    expect(up.lastPingedAt).toBeTypeOf('number');
    expect(down.status).toBe('unreachable');
  });

  it('tracks consecutive transport failures and resets them on success', async () => {
    expect(getAgent('a1').transportFailures).toBe(0);
    expect(getAgent('a1').lastOkAt).toBeTypeOf('number');
    expect(getAgent('a1').upSinceAt).toBeTypeOf('number');
    expect(getAgent('a2').transportFailures).toBe(1);

    await runHeartbeat();
    expect(getAgent('a2').transportFailures).toBe(2);
  });

  it('reports zero when there are no agents', async () => {
    db.delete(taskRuns).run();
    db.delete(agents).run();
    expect(await runHeartbeat()).toEqual({ checked: 0 });
  });
});

describe('runDeepHeartbeat — outage tracking', () => {
  beforeEach(() => {
    db.delete(taskRuns).run();
    db.delete(agents).run();
    addAgent('d1', 'up');
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, supported: true, text: 'OK' });
  });

  it('a real reply passes: resets both counters and stamps lastOkAt/upSinceAt', async () => {
    db.update(agents).set({ transportFailures: 3, deepFailures: 1 }).where(eq(agents.id, 'd1')).run();

    const res = await runDeepHeartbeat();
    expect(res).toEqual({ checked: 1, failed: 0, skipped: 0 });

    const row = getAgent('d1');
    expect(row.status).toBe('connected');
    expect(row.transportFailures).toBe(0);
    expect(row.deepFailures).toBe(0);
    expect(row.lastOkAt).toBeTypeOf('number');
    expect(row.upSinceAt).toBeTypeOf('number');
  });

  it('a failed deep ping increments deepFailures; a transport success does NOT reset it', async () => {
    dispatchMock.mockResolvedValue({ ok: false, supported: true, error: 'bad credentials' });

    const res = await runDeepHeartbeat();
    expect(res.failed).toBe(1);
    expect(getAgent('d1').deepFailures).toBe(1);
    expect(getAgent('d1').status).toBe('unreachable');

    // Gateway reachable, AI broken — the motivating scenario: the transport
    // success must not mask the deep failure.
    await runHeartbeat();
    const row = getAgent('d1');
    expect(row.status).toBe('connected');
    expect(row.transportFailures).toBe(0);
    expect(row.deepFailures).toBe(1);
  });

  it('an async ACK with no captured text counts as a failure', async () => {
    dispatchMock.mockResolvedValue({ ok: true, supported: true, async: true });

    const res = await runDeepHeartbeat();
    expect(res.failed).toBe(1);
    expect(getAgent('d1').deepFailures).toBe(1);
  });

  it('reaching the threshold marks the outage notified exactly once', async () => {
    dispatchMock.mockResolvedValue({ ok: false, supported: true, error: 'bad credentials' });

    await runDeepHeartbeat();
    expect(getAgent('d1').downNotifiedAt).toBeNull(); // 1 failure < default threshold 2

    await runDeepHeartbeat();
    const notifiedAt = getAgent('d1').downNotifiedAt;
    expect(notifiedAt).toBeTypeOf('number'); // threshold reached

    await runDeepHeartbeat();
    expect(getAgent('d1').downNotifiedAt).toBe(notifiedAt); // not re-notified
    expect(getAgent('d1').deepFailures).toBe(3);
  });

  it('skips busy agents without dispatching or touching counters', async () => {
    db.insert(taskRuns).values({
      id: 'r1', token: 't1', agentId: 'd1', pageId: 'page-1', anchorKind: 'task',
      status: 'in_flight', createdAt: Date.now(),
    }).run();

    const res = await runDeepHeartbeat();
    expect(res).toEqual({ checked: 0, failed: 0, skipped: 1 });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(getAgent('d1').deepFailures).toBe(0);
  });

  it('recovery clears the outage marker and refreshes upSinceAt', async () => {
    const past = Date.now() - 60 * 60_000;
    db.update(agents).set({
      transportFailures: 2, deepFailures: 2, downNotifiedAt: past,
      upSinceAt: past - 86_400_000, lastOkAt: past,
    }).where(eq(agents.id, 'd1')).run();

    await runDeepHeartbeat();

    const row = getAgent('d1');
    expect(row.transportFailures).toBe(0);
    expect(row.deepFailures).toBe(0);
    expect(row.downNotifiedAt).toBeNull();
    expect(row.upSinceAt!).toBeGreaterThan(past); // a fresh up-period started
    expect(row.lastOkAt!).toBeGreaterThan(past);
  });
});
