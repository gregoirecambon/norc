import { describe, it, expect } from 'vitest';
import { decideSync } from '../chores/sync.js';

// The reconcile decision matrix is pure (decideSync) — the Notion plumbing around it
// just executes the chosen action.
describe('decideSync', () => {
  it('disk-only → create the Notion row', () => {
    expect(decideSync({ hash: 'a' }, null)).toBe('create');
  });

  it('notion-only (parseable) → pull to disk', () => {
    expect(decideSync(null, { hash: 'a', baseline: '' })).toBe('pull');
  });

  it('notion-only (unparseable) → noop', () => {
    expect(decideSync(null, { hash: null, baseline: '' })).toBe('noop');
  });

  it('equal hashes → noop (steady state / loop guard)', () => {
    expect(decideSync({ hash: 'a' }, { hash: 'a', baseline: 'a' })).toBe('noop');
  });

  it('only disk changed since baseline → push', () => {
    expect(decideSync({ hash: 'b' }, { hash: 'a', baseline: 'a' })).toBe('push');
  });

  it('only Notion changed since baseline → pull', () => {
    expect(decideSync({ hash: 'a' }, { hash: 'b', baseline: 'a' })).toBe('pull');
  });

  it('both changed since baseline → conflict (never clobber)', () => {
    expect(decideSync({ hash: 'b' }, { hash: 'c', baseline: 'a' })).toBe('conflict');
  });

  it('first sight, no baseline, differing → push (disk is canonical)', () => {
    expect(decideSync({ hash: 'b' }, { hash: 'c', baseline: '' })).toBe('push');
  });

  it('unparseable Notion body but disk exists → restore from disk', () => {
    expect(decideSync({ hash: 'a' }, { hash: null, baseline: 'x' })).toBe('restore');
  });
});
