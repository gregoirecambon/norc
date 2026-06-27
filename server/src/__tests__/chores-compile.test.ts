import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations, db } from '../db/client.js';
import { pendingChoreCasts } from '../db/schema.js';
import { parseChore } from '../chores/parse.js';
import { compileChore } from '../chores/compile.js';
import type { CompileDeps, ChoreProposedTask, ResolvedCastStep } from '../chores/types.js';

beforeAll(() => { runMigrations(); });
beforeEach(() => { db.delete(pendingChoreCasts).run(); });

const CHORE = parseChore(`---
chore: blog
description: research then draft
approval: auto
min_confidence: 0.5
inputs: [topic]
---

### 1. Research
needs: research
do: Research {topic}.
returns: a brief

### 2. Draft
needs: writing
do: Draft from the brief.
after: [1]
`);

interface Spy { dag: ChoreProposedTask[]; casts: string[]; notes: string[] }

function makeDeps(over: Partial<CompileDeps> = {}): CompileDeps & Spy {
  const dag: ChoreProposedTask[] = []; const casts: string[] = []; const notes: string[] = [];
  return {
    resolveCast: async (needs): Promise<ResolvedCastStep> => ({
      stepIndex: 0, number: 0, capability: needs, agentName: `Agent-${needs}`, orgDbPageId: `org-${needs}`, confidence: 0.9,
    }),
    createDag: async (tasks) => { dag.push(...tasks); return { created: tasks.map((t, i) => ({ id: `p${i}`, title: t.title })) }; },
    announce: async (t) => { notes.push(t); },
    postCast: async (t) => { casts.push(t); return { commentId: 'c1', discussionId: 'd1' }; },
    dag, casts, notes,
    ...over,
  };
}

describe('compileChore', () => {
  it('auto + all steps resolved → builds a pre-assigned, dependency-wired DAG', async () => {
    const d = makeDeps();
    const outcome = await compileChore(d, { chore: CHORE, inputs: { topic: 'golf' }, sourcePageId: 'src', pageId: 'src', via: 'forced' });
    expect(outcome).toBe('compiled');
    expect(d.dag).toHaveLength(2);
    expect(d.dag[0]!.assigneeIds).toEqual(['org-research']);
    expect(d.dag[0]!.description).toContain('Research golf.');
    expect(d.dag[0]!.description).toContain('Expected output:');
    expect(d.dag[1]!.dependsOn).toEqual([0]);
    expect(d.dag[1]!.assigneeIds).toEqual(['org-writing']);
    expect(d.casts).toHaveLength(0);
  });

  it('missing input → blocked, asks the human, builds nothing', async () => {
    const d = makeDeps();
    const outcome = await compileChore(d, { chore: CHORE, inputs: {}, sourcePageId: 'src', pageId: 'src', via: 'triage' });
    expect(outcome).toBe('blocked');
    expect(d.notes[0]).toMatch(/needs: topic/);
    expect(d.dag).toHaveLength(0);
  });

  it('auto but a step is unconfident → parks a cast for approval (fail-safe)', async () => {
    const d = makeDeps({
      resolveCast: async (needs): Promise<ResolvedCastStep> => needs === 'writing'
        ? { stepIndex: 0, number: 0, capability: needs, agentName: null, orgDbPageId: null, confidence: 0.1 }
        : { stepIndex: 0, number: 0, capability: needs, agentName: 'A', orgDbPageId: 'org-A', confidence: 0.9 },
    });
    const outcome = await compileChore(d, { chore: CHORE, inputs: { topic: 'golf' }, sourcePageId: 'src', pageId: 'src', via: 'triage' });
    expect(outcome).toBe('awaiting-cast');
    expect(d.casts).toHaveLength(1);
    expect(d.dag).toHaveLength(0);
    expect(db.select().from(pendingChoreCasts).all()).toHaveLength(1);
  });

  it('approval:cast always parks a cast even when fully resolved', async () => {
    const castChore = parseChore(CHORE.raw.replace('approval: auto', 'approval: cast'));
    const d = makeDeps();
    const outcome = await compileChore(d, { chore: castChore, inputs: { topic: 'golf' }, sourcePageId: 's', pageId: 's', via: 'forced' });
    expect(outcome).toBe('awaiting-cast');
    expect(d.dag).toHaveLength(0);
    expect(d.casts).toHaveLength(1);
  });
});
