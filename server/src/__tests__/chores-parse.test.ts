import { describe, it, expect } from 'vitest';
import { parseChore } from '../chores/parse.js';
import { detectForcedChore, substituteInputs } from '../chores/force.js';

const GOOD = `---
chore: ship-blog-post
description: Research, draft, review
trigger: mention
inputs: [topic]
approval: cast
min_confidence: 0.6
---

### 1. Research
needs: web research
do: Gather sources on {topic}.
returns: a sourced brief

### 2. Draft
needs: long-form writing
do: Write a post from the brief.
returns: a draft
after: [1]
`;

describe('parseChore', () => {
  it('parses frontmatter + steps', () => {
    const c = parseChore(GOOD);
    expect(c.id).toBe('ship-blog-post');
    expect(c.trigger).toBe('mention');
    expect(c.approval).toBe('cast');
    expect(c.minConfidence).toBe(0.6);
    expect(c.inputs).toEqual(['topic']);
    expect(c.steps).toHaveLength(2);
    expect(c.steps[0]!.needs).toBe('web research');
    expect(c.steps[0]!.do).toBe('Gather sources on {topic}.');
    // 1-based "after: [1]" becomes the 0-based index 0.
    expect(c.steps[1]!.after).toEqual([0]);
  });

  it('strips trailing inline comments from scalar fields', () => {
    const c = parseChore(GOOD.replace('trigger: mention', 'trigger: mention   # a | b | c'));
    expect(c.trigger).toBe('mention');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseChore('no frontmatter here')).toThrow();
  });

  it('throws when a step is missing do:', () => {
    expect(() => parseChore(GOOD.replace('do: Write a post from the brief.', ''))).toThrow(/missing "do/);
  });

  it('throws when after references an unknown/later step', () => {
    expect(() => parseChore('---\nchore: x\ndescription: d\n---\n\n### 1. A\nneeds: n\ndo: d\nafter: [2]\n')).toThrow();
  });

  it('defaults approval to cast and min_confidence to 0.6', () => {
    const c = parseChore('---\nchore: x\ndescription: d\n---\n\n### 1. A\nneeds: n\ndo: d\n');
    expect(c.approval).toBe('cast');
    expect(c.minConfidence).toBe(0.6);
    expect(c.steps[0]!.after).toEqual([]);
  });
});

describe('detectForcedChore', () => {
  const ids = ['ship-blog-post', 'do-thing'];
  it('matches /chore <id>', () => {
    expect(detectForcedChore('please /chore ship-blog-post now', ids)?.id).toBe('ship-blog-post');
  });
  it('matches [[chore:id]]', () => {
    expect(detectForcedChore('run [[chore:do-thing]] today', ids)?.id).toBe('do-thing');
  });
  it('returns null for an unknown id', () => {
    expect(detectForcedChore('/chore nope', ids)).toBeNull();
  });
  it('returns null when no token present', () => {
    expect(detectForcedChore('just a normal task', ids)).toBeNull();
  });
  it('extracts key="quoted value" inputs', () => {
    const f = detectForcedChore('/chore ship-blog-post topic="golf swing"', ids);
    expect(f?.inputs['topic']).toBe('golf swing');
  });
});

describe('substituteInputs', () => {
  it('fills known placeholders', () => {
    expect(substituteInputs('on {topic}', { topic: 'golf' }).text).toBe('on golf');
  });
  it('leaves and reports unknown placeholders', () => {
    const r = substituteInputs('on {topic}', {});
    expect(r.text).toBe('on {topic}');
    expect(r.missing).toContain('topic');
  });
});
