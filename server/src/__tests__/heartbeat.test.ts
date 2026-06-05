import { describe, it, expect, beforeAll, vi } from 'vitest';

// Stub the adapter ping so the heartbeat doesn't hit the network: an agent named
// "up" is reachable, anything else is not.
vi.mock('../adapters/index.js', () => ({
  pingAgent: vi.fn(async (agent: { name: string }) =>
    agent.name === 'up' ? { ok: true, latencyMs: 7 } : { ok: false, latencyMs: 0, error: 'down' }),
}));

import { runMigrations, db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { runHeartbeat } from '../lib/heartbeat.js';

function addAgent(id: string, name: string) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}',
  }).run();
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

    const up = db.select().from(agents).where(eq(agents.id, 'a1')).all()[0]!;
    const down = db.select().from(agents).where(eq(agents.id, 'a2')).all()[0]!;
    expect(up.status).toBe('connected');
    expect(up.lastLatencyMs).toBe(7);
    expect(up.lastPingedAt).toBeTypeOf('number');
    expect(down.status).toBe('unreachable');
  });

  it('reports zero when there are no agents', async () => {
    db.delete(agents).run();
    expect(await runHeartbeat()).toEqual({ checked: 0 });
  });
});
