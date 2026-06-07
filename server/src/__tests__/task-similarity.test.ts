import { describe, it, expect } from 'vitest';
import { tokenize, titleSimilarity, normalizedTitle, heuristicCandidates } from '../lib/task-similarity.js';

describe('tokenize', () => {
  it('lowercases, strips punctuation and short words', () => {
    expect(tokenize('Fix the Login-Bug!')).toEqual(['fix', 'login', 'bug']);
  });

  it('strips French accents and stopwords', () => {
    expect(tokenize("Rédiger l'article de blog pour le lancement")).toEqual(['rediger', 'article', 'blog', 'lancement']);
  });

  it('drops English stopwords', () => {
    expect(tokenize('Write a summary of the meeting')).toEqual(['write', 'summary', 'meeting']);
  });
});

describe('titleSimilarity', () => {
  it('identical titles score 1', () => {
    expect(titleSimilarity('Fix login bug', 'Fix login bug')).toBe(1);
  });

  it('stopword/punctuation variations still score 1 (containment)', () => {
    expect(titleSimilarity('Fix login bug', 'Fix the login bug!')).toBe(1);
  });

  it('a subset title is contained by its superset', () => {
    // {fix, login, bug} ⊂ {fix, login, bug, ios, app} → containment 1
    expect(titleSimilarity('Fix login bug', 'Fix login bug in the iOS app')).toBe(1);
  });

  it('disjoint titles score 0', () => {
    expect(titleSimilarity('Fix login bug', 'Write pricing page copy')).toBe(0);
  });

  it('partial overlap lands between thresholds', () => {
    // {prepare, q3, pricing, strategy, deck} vs {review, pricing, strategy, options, europe}
    // common 2 → containment 2/5 = 0.4
    const s = titleSimilarity('Prepare Q3 pricing strategy deck', 'Review pricing strategy options Europe');
    expect(s).toBeCloseTo(0.4);
  });

  it('empty/stopword-only titles score 0', () => {
    expect(titleSimilarity('the of a', 'Fix login bug')).toBe(0);
  });
});

describe('normalizedTitle', () => {
  it('is token-order independent', () => {
    expect(normalizedTitle('Login bug fix')).toBe(normalizedTitle('Fix the login bug'));
  });
});

describe('heuristicCandidates', () => {
  const tasks = [
    { id: '1', title: 'Fix login bug' },
    { id: '2', title: 'Review pricing strategy options Europe' },  // 0.4 vs the pricing query
    { id: '3', title: 'Write blog article' },
  ];

  it('exact normalized match always blocks with score 1', () => {
    const out = heuristicCandidates('The login bug — fix!', tasks, t => t.title);
    expect(out[0]).toMatchObject({ task: { id: '1' }, score: 1, blocking: true });
  });

  it('judge-zone scores (≥ judgeAt, < blockAt) surface but do not block', () => {
    const out = heuristicCandidates('Prepare Q3 pricing strategy deck', tasks, t => t.title);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ task: { id: '2' }, blocking: false });
    expect(out[0]!.score).toBeCloseTo(0.4);
  });

  it('below judgeAt nothing surfaces', () => {
    expect(heuristicCandidates('Refactor billing webhooks', tasks, t => t.title)).toHaveLength(0);
  });

  it('sorts best-first and caps at max', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), title: 'fix login bug' }));
    const out = heuristicCandidates('Fix login bug', many, t => t.title, { max: 8 });
    expect(out).toHaveLength(8);
    expect(out.every(c => c.blocking)).toBe(true);
  });

  it('respects custom thresholds', () => {
    const out = heuristicCandidates('Prepare Q3 pricing strategy deck', tasks, t => t.title, { blockAt: 0.4 });
    expect(out[0]!.blocking).toBe(true);
  });
});
