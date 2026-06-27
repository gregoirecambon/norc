import { describe, it, expect } from 'vitest';
import { parseChore } from '../chores/parse.js';
import { serializeChore, choreContentHash } from '../chores/serialize.js';

const SRC = `---
chore: ship-blog-post
description: Research, draft, review a post
trigger: mention
inputs: [topic]
binding: plan-time
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
returns: a markdown draft
after: [1]

### 3. Review
needs: editorial review
do: Check the draft against the brief.
returns: the final post
after: [2]
`;

describe('serializeChore round-trip', () => {
  it('parseChore(serializeChore(doc)) preserves the structural fields', () => {
    const a = parseChore(SRC);
    const b = parseChore(serializeChore(a));
    expect(b.id).toBe(a.id);
    expect(b.description).toBe(a.description);
    expect(b.trigger).toBe(a.trigger);
    expect(b.inputs).toEqual(a.inputs);
    expect(b.approval).toBe(a.approval);
    expect(b.minConfidence).toBe(a.minConfidence);
    expect(b.steps.map(s => [s.number, s.needs, s.do, s.returns, s.after]))
      .toEqual(a.steps.map(s => [s.number, s.needs, s.do, s.returns, s.after]));
  });

  it('is idempotent: serialize == serialize(parse(serialize))', () => {
    const a = parseChore(SRC);
    const once = serializeChore(a);
    const twice = serializeChore(parseChore(once));
    expect(twice).toBe(once);
  });

  it('content hash is stable across whitespace-only differences in the source', () => {
    const messy = SRC
      .replace('needs: web research', 'needs:   web research   ')
      .replace('trigger: mention', 'trigger: mention   # a comment');
    expect(choreContentHash(parseChore(messy))).toBe(choreContentHash(parseChore(SRC)));
  });

  it('content hash changes when a step actually changes', () => {
    const edited = SRC.replace('do: Write a post from the brief.', 'do: Write a LONG post from the brief.');
    expect(choreContentHash(parseChore(edited))).not.toBe(choreContentHash(parseChore(SRC)));
  });
});
