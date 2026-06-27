import { describe, it, expect } from 'vitest';
import { parseReturnsVerdict } from '../lib/orchestrator-agent.js';
import { extractExpectedOutput } from '../lib/orchestrator.js';

describe('parseReturnsVerdict', () => {
  it('reads an explicit pass', () => {
    expect(parseReturnsVerdict('{"pass":true}').pass).toBe(true);
  });
  it('reads an explicit fail + feedback', () => {
    const v = parseReturnsVerdict('{"pass":false,"feedback":"no sources cited"}');
    expect(v.pass).toBe(false);
    expect(v.feedback).toBe('no sources cited');
  });
  it('defaults to pass on garbage (never block a pipeline on a bad/absent verdict)', () => {
    expect(parseReturnsVerdict('not json').pass).toBe(true);
    expect(parseReturnsVerdict('{}').pass).toBe(true);
  });
});

describe('extractExpectedOutput', () => {
  it('pulls the contract written into a task body', () => {
    const body = 'Write a post on golf.\n\nExpected output:\na markdown draft with a title';
    expect(extractExpectedOutput(body)).toBe('a markdown draft with a title');
  });
  it('returns empty when there is no contract (not a chore step)', () => {
    expect(extractExpectedOutput('Just do the thing.')).toBe('');
  });
  it('captures only the contiguous block after the marker (ignores later content)', () => {
    const body = 'Do it.\n\nExpected output:\na sourced brief\n\nSome later agent note that should be ignored.';
    expect(extractExpectedOutput(body)).toBe('a sourced brief');
  });
  it('is case-insensitive on the marker', () => {
    expect(extractExpectedOutput('x\n\nexpected output:\nthe result')).toBe('the result');
  });
});
