import { describe, it, expect } from 'vitest';
import { parseDecision, buildTriagePrompt, type TriageCandidate, type TriageInput } from '../lib/orchestrator-agent.js';

const cands: TriageCandidate[] = [{ name: 'Writer', specialty: 'writing', capabilities: 'blog posts' }];
const chores = [{ id: 'ship-blog-post', description: 'research, draft, review a post' }];

describe('parseDecision — chore branch', () => {
  it('accepts a known chore id', () => {
    const d = parseDecision('{"decision":"chore","chore":"ship-blog-post","confidence":0.8,"message":"m"}', cands, ['ship-blog-post']);
    expect(d.decision).toBe('chore');
    if (d.decision === 'chore') expect(d.chore).toBe('ship-blog-post');
  });

  it('ignores an unknown chore id', () => {
    const d = parseDecision('{"decision":"chore","chore":"nope","confidence":0.8,"message":""}', cands, ['ship-blog-post']);
    expect(d.decision).toBe('ignore');
  });

  it('ignores a chore decision when no chore ids are known', () => {
    const d = parseDecision('{"decision":"chore","chore":"x","confidence":0.8,"message":""}', cands);
    expect(d.decision).toBe('ignore');
  });

  it('still routes to a normal agent', () => {
    const d = parseDecision('{"decision":"route","agent":"Writer","confidence":0.9,"message":"m"}', cands, ['ship-blog-post']);
    expect(d.decision).toBe('route');
    if (d.decision === 'route') expect(d.agent).toBe('Writer');
  });
});

describe('buildTriagePrompt — chore gating', () => {
  const base: TriageInput = {
    provider: 'anthropic', apiKey: 'k', model: 'm', kind: 'task', title: 'T', text: 'x', candidates: cands,
  };

  it('omits the chores block + chore decision when none are given', () => {
    const p = buildTriagePrompt(base);
    expect(p).not.toContain('AVAILABLE CHORES');
    expect(p).not.toContain('"chore"');
  });

  it('includes the chores block + chore decision when chores are present', () => {
    const p = buildTriagePrompt({ ...base, chores });
    expect(p).toContain('AVAILABLE CHORES');
    expect(p).toContain('ship-blog-post');
    expect(p).toContain('"chore"');
  });
});
