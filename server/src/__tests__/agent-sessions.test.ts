import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations, db } from '../db/client.js';
import { agents, agentSessions } from '../db/schema.js';
import { resolveSession } from '../lib/agent-sessions.js';

function addAgent(id = 'a1', name = 'alpha') {
  db.insert(agents).values({
    id, name, adapterType: 'openclaw', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns: 1,
  }).run();
}

const FP_A = 'fingerprint-a';
const FP_B = 'fingerprint-b';

const work = (fingerprint: string, adapterType: 'openclaw' | 'claude-api' = 'openclaw') =>
  resolveSession({ agentId: 'a1', pageId: 'p1', lane: 'work', fingerprint, adapterType });
const chat = (fingerprint: string) =>
  resolveSession({ agentId: 'a1', pageId: 'p1', lane: 'chat', fingerprint, adapterType: 'openclaw' });

function rows() {
  return db.select().from(agentSessions).all();
}

beforeAll(() => { runMigrations(); });
beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(agents).run();
  addAgent();
});

describe('resolveSession — openclaw (session-capable)', () => {
  it('first contact returns the bare page id (no #g) and stores epoch 1', () => {
    const r = work(FP_A);
    expect(r).toEqual({ sessionId: 'p1', reused: false });
    const row = rows()[0]!;
    expect(row.sessionId).toBe('p1');
    expect(row.epoch).toBe(1);
    expect(row.fingerprint).toBe(FP_A);
  });

  it('reuses the same session while the fingerprint is unchanged', () => {
    work(FP_A);
    const r = work(FP_A);
    expect(r).toEqual({ sessionId: 'p1', reused: true });
    expect(rows()).toHaveLength(1); // still one row, just touched
  });

  it('rebuilds (epoch++ → #g2) when the fingerprint changes', () => {
    work(FP_A);
    const r = work(FP_B);
    expect(r).toEqual({ sessionId: 'p1#g2', reused: false });
    expect(rows()[0]!.epoch).toBe(2);
    expect(rows()[0]!.fingerprint).toBe(FP_B);
  });

  it('never re-enters a prior session: changed → reverted still advances (#g3)', () => {
    work(FP_A);          // p1     (epoch 1)
    work(FP_B);          // p1#g2  (epoch 2)
    const r = work(FP_A); // reverting the fingerprint must NOT reuse p1
    expect(r).toEqual({ sessionId: 'p1#g3', reused: false });
    expect(rows()[0]!.epoch).toBe(3);
  });

  it('keys work and chat lanes separately (independent epoch chains)', () => {
    expect(work(FP_A)).toEqual({ sessionId: 'p1', reused: false });
    expect(chat(FP_A)).toEqual({ sessionId: 'p1#chat', reused: false });
    // A chat-side context change bumps only the chat chain.
    expect(chat(FP_B)).toEqual({ sessionId: 'p1#chat#g2', reused: false });
    // The work session is untouched and still reuses.
    expect(work(FP_A)).toEqual({ sessionId: 'p1', reused: true });
    expect(rows()).toHaveLength(2);
  });
});

describe('resolveSession — stateless adapters', () => {
  it('claude-api always re-assembles clean and never writes a session row', () => {
    expect(work(FP_A, 'claude-api')).toEqual({ sessionId: 'p1', reused: false });
    expect(work(FP_B, 'claude-api')).toEqual({ sessionId: 'p1', reused: false });
    expect(rows()).toHaveLength(0);
  });
});
