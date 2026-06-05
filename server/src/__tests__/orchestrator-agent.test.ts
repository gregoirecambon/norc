import { describe, it, expect } from 'vitest';
import { parseDecision, type TriageCandidate } from '../lib/orchestrator-agent.js';

const candidates: TriageCandidate[] = [
  { name: 'emilien', specialty: 'copywriter', capabilities: 'copywriting' },
  { name: 'dimi', specialty: 'developer', capabilities: 'code' },
];

describe('parseDecision', () => {
  it('parses a clean route decision and validates the agent', () => {
    const d = parseDecision('{"decision":"route","agent":"emilien","confidence":0.9,"message":"@emilien take this"}', candidates);
    expect(d).toEqual({ decision: 'route', agent: 'emilien', confidence: 0.9, message: '@emilien take this' });
  });

  it('tolerates @-prefix, wrong case, and surrounding prose', () => {
    const d = parseDecision('Here you go:\n{"decision":"route","agent":"@Dimi","confidence":0.8,"message":"x"}\nthanks', candidates);
    expect(d.decision).toBe('route');
    expect(d.agent).toBe('dimi');
  });

  it('downgrades route→ignore when the agent is not in the roster', () => {
    const d = parseDecision('{"decision":"route","agent":"ghost","confidence":0.95,"message":"x"}', candidates);
    expect(d.decision).toBe('ignore');
    expect(d.agent).toBeNull();
  });

  it('keeps suggest even with a null agent and clamps confidence', () => {
    const d = parseDecision('{"decision":"suggest","agent":null,"confidence":1.5,"message":"unsure"}', candidates);
    expect(d).toEqual({ decision: 'suggest', agent: null, confidence: 1, message: 'unsure' });
  });

  it('falls back to ignore on non-JSON / garbage', () => {
    expect(parseDecision('the agent could not decide', candidates).decision).toBe('ignore');
    expect(parseDecision('', candidates).decision).toBe('ignore');
  });
});
