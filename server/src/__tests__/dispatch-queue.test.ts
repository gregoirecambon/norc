import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations, db } from '../db/client.js';
import { agents, taskRuns, dispatchQueue } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { onEvent, type NorcEvent } from '../lib/events.js';
import {
  enqueueTurn, pendingCount, pendingItems, nextEligible, claimAndCheck,
  dropItem, dropPendingForAgentPage, agentsWithPending, type QueuedTurn,
} from '../lib/dispatch-queue.js';
import { activeRunCount, hasRunConflict, createRun } from '../lib/runs.js';

const PAYLOAD: QueuedTurn = { request: 'do it', manageTaskStatus: true, how: 'assignment' };

function addAgent(id: string, name: string, maxConcurrentRuns = 1) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}', maxConcurrentRuns,
  }).run();
}

function addInFlightRun(agentId: string, pageId: string, projectId: string | null, lane: 'work' | 'chat' = 'work') {
  return createRun({ agentId, pageId, taskPageId: pageId, anchorKind: 'task', projectId, lane, manageTaskStatus: true });
}

function enqueue(agentId: string, pageId: string, projectId: string | null, priority?: number) {
  return enqueueTurn({ agentId, pageId, taskPageId: pageId, projectId, anchorKind: 'task', title: pageId, payload: PAYLOAD, ...(priority !== undefined ? { priority } : {}) });
}

beforeAll(() => { runMigrations(); });

beforeEach(() => {
  db.delete(dispatchQueue).run();
  db.delete(taskRuns).run();
  db.delete(agents).run();
  addAgent('a1', 'alpha');
});

describe('capacity helpers', () => {
  it('activeRunCount counts only in-flight WORK runs', () => {
    addInFlightRun('a1', 'p1', 'projA');
    addInFlightRun('a1', 'p2', null, 'chat'); // chat lane exempt
    expect(activeRunCount('a1')).toBe(1);
  });

  it('hasRunConflict matches same page OR same project, work lane only', () => {
    addInFlightRun('a1', 'p1', 'projA');
    expect(hasRunConflict('a1', 'projA', 'other-page')).toBe(true);  // project conflict
    expect(hasRunConflict('a1', null, 'p1')).toBe(true);             // page conflict
    expect(hasRunConflict('a1', 'projB', 'p9')).toBe(false);
    expect(hasRunConflict('a1', null, 'p9')).toBe(false);
  });
});

describe('queue ordering — FIFO with cross-project overtake', () => {
  it('is FIFO when nothing conflicts', () => {
    enqueue('a1', 'p1', 'projA');
    enqueue('a1', 'p2', 'projB');
    expect(nextEligible('a1')?.pageId).toBe('p1');
  });

  it('lets a younger item from another project overtake a blocked head', () => {
    addInFlightRun('a1', 'pX', 'projA');
    enqueue('a1', 'p1', 'projA'); // blocked: projA in flight
    enqueue('a1', 'p2', 'projB'); // free
    expect(nextEligible('a1')?.pageId).toBe('p2');
  });

  it('stays strict FIFO within one project (a skipped head blocks its siblings)', () => {
    addInFlightRun('a1', 'pX', 'projA');
    enqueue('a1', 'p1', 'projA');
    enqueue('a1', 'p2', 'projA'); // must NOT overtake p1
    expect(nextEligible('a1')).toBeNull();
  });

  it('propagates the blocked set per page too', () => {
    addInFlightRun('a1', 'p1', null);
    enqueue('a1', 'p1', null); // blocked: same page in flight
    enqueue('a1', 'p1', null); // also blocked (behind its sibling)
    enqueue('a1', 'p2', null); // free
    expect(nextEligible('a1')?.pageId).toBe('p2');
  });
});

describe('queue ordering — priority lane', () => {
  it('a priority item enqueued last drains first and reports position 1', () => {
    enqueue('a1', 'p1', 'projA');
    enqueue('a1', 'p2', 'projB');
    const { position } = enqueue('a1', 'p3', 'projC', 1);
    expect(position).toBe(1);
    expect(nextEligible('a1')?.pageId).toBe('p3');
    expect(pendingItems('a1').map(r => r.pageId)).toEqual(['p3', 'p1', 'p2']);
  });

  it('normal enqueues still report their tail position', () => {
    enqueue('a1', 'p1', null, 1);
    const { position } = enqueue('a1', 'p2', null);
    expect(position).toBe(2);
  });

  it('equal-priority items stay FIFO among themselves', () => {
    enqueue('a1', 'p1', 'projA', 1);
    enqueue('a1', 'p2', 'projB', 1);
    expect(nextEligible('a1')?.pageId).toBe('p1');
    expect(pendingItems('a1').map(r => r.pageId)).toEqual(['p1', 'p2']);
  });

  it('a blocked priority item still poisons its project; other projects overtake', () => {
    addInFlightRun('a1', 'pX', 'projA');
    enqueue('a1', 'p1', 'projA', 1); // priority but blocked: projA in flight
    enqueue('a1', 'p2', 'projA');    // must NOT overtake its blocked sibling
    enqueue('a1', 'p3', 'projB');    // free — overtakes
    expect(nextEligible('a1')?.pageId).toBe('p3');
  });
});

describe('claimAndCheck', () => {
  it('claims an eligible item exactly once', () => {
    const { id } = enqueue('a1', 'p1', 'projA');
    expect(claimAndCheck(id, 'a1', 'projA', 'p1', 1)).toBe(true);
    expect(claimAndCheck(id, 'a1', 'projA', 'p1', 1)).toBe(false); // already dispatched
    expect(pendingCount('a1')).toBe(0);
  });

  it('refuses when capacity was consumed between peek and claim', () => {
    const { id } = enqueue('a1', 'p1', 'projA');
    addInFlightRun('a1', 'pZ', 'projZ'); // webhook turn won the race
    expect(claimAndCheck(id, 'a1', 'projA', 'p1', 1)).toBe(false);
    expect(pendingCount('a1')).toBe(1);  // still pending — next drain gets it
  });

  it('refuses when a project conflict appeared in the meantime', () => {
    const { id } = enqueue('a1', 'p1', 'projA');
    addInFlightRun('a1', 'pZ', 'projA');
    expect(claimAndCheck(id, 'a1', 'projA', 'p1', 5)).toBe(false);
  });
});

describe('drops + events', () => {
  it('dropItem marks the row dropped and emits queue.updated', () => {
    const events: NorcEvent[] = [];
    const off = onEvent(e => { if (e.type === 'queue.updated') events.push(e); });
    const { id } = enqueue('a1', 'p1', null);
    dropItem(id, 'task went Draft');
    off();
    expect(pendingCount('a1')).toBe(0);
    const row = db.select().from(dispatchQueue).where(eq(dispatchQueue.id, id)).all()[0]!;
    expect(row.status).toBe('dropped');
    expect(row.droppedReason).toBe('task went Draft');
    // one event for the enqueue, one for the drop
    expect(events.length).toBe(2);
    expect(events.at(-1)?.data).toEqual({ agentId: 'a1', pending: 0 });
  });

  it('dropPendingForAgentPage drops every pending sibling on that page only', () => {
    enqueue('a1', 'p1', null);
    enqueue('a1', 'p1', null);
    enqueue('a1', 'p2', null);
    const n = dropPendingForAgentPage('a1', 'p1', 'superseded by timeout escalation');
    expect(n).toBe(2);
    expect(pendingItems('a1').map(r => r.pageId)).toEqual(['p2']);
  });

  it('agentsWithPending lists distinct agents', () => {
    addAgent('a2', 'beta');
    enqueue('a1', 'p1', null);
    enqueue('a1', 'p2', null);
    enqueue('a2', 'p3', null);
    expect(agentsWithPending().sort()).toEqual(['a1', 'a2']);
  });

  it('queue rows die with the agent (FK cascade)', () => {
    enqueue('a1', 'p1', null);
    db.delete(agents).where(eq(agents.id, 'a1')).run();
    expect(db.select().from(dispatchQueue).all().length).toBe(0);
  });
});
