import { describe, it, expect } from 'vitest';
import { parseDecision, parseAssessment, parseTaskWorthy, parseProjectInference, parseBusinessTasks, openaiEndpoint, buildTriagePrompt, rosterBlock, type TriageCandidate, type TriageInput } from '../lib/orchestrator-agent.js';

describe('openaiEndpoint', () => {
  it('appends /v1/chat/completions to a bare host', () => {
    expect(openaiEndpoint('http://localhost:4000')).toBe('http://localhost:4000/v1/chat/completions');
    expect(openaiEndpoint('http://localhost:4000/')).toBe('http://localhost:4000/v1/chat/completions');
  });
  it('appends /chat/completions to a /v1 base', () => {
    expect(openaiEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
  });
  it('leaves a full endpoint untouched', () => {
    expect(openaiEndpoint('http://proxy/v1/chat/completions')).toBe('http://proxy/v1/chat/completions');
  });
});

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

function triageInput(extra: Partial<TriageInput> = {}): TriageInput {
  return {
    provider: 'anthropic', apiKey: 'k', model: 'm',
    kind: 'task', title: 'Onboarding cleaning', text: '',
    candidates,
    ...extra,
  };
}

describe('rosterBlock', () => {
  it('renders empty specialty/capabilities explicitly as "(none listed)"', () => {
    const block = rosterBlock({ name: 'lili', specialty: '', capabilities: '', activeRuns: 0, maxConcurrentRuns: 1 });
    expect(block).toContain('### lili');
    expect(block).toContain('Specialty: (none listed)');
    expect(block).toContain('Capabilities: (none listed)');
    expect(block).toContain('About: (no description)');
    expect(block).toContain('Load: 0 running, 0 queued / cap 1');
  });

  it('renders enriched properties and the description', () => {
    const block = rosterBlock({
      name: 'dimi', specialty: 'developer', capabilities: 'code', technology: 'Claude Code',
      description: 'Backend engineer for the API.',
      properties: [{ name: 'Status', value: 'Available' }, { name: 'Owner email', value: 'a@b.c' }],
    });
    expect(block).toContain('Specialty: developer');
    expect(block).toContain('Technology: Claude Code');
    expect(block).toContain('Status: Available');
    expect(block).toContain('Owner email: a@b.c');
    expect(block).toContain('About: Backend engineer for the API.');
    expect(block).not.toContain('Load:'); // no load info provided
  });
});

describe('buildTriagePrompt', () => {
  it('always includes the calibration rule and the unchanged JSON schema line', () => {
    const p = buildTriagePrompt(triageInput());
    expect(p).toContain('you MUST set confidence below 0.5');
    expect(p).toContain('{"decision":"route"|"suggest"|"ignore","agent":"<exact agent name from the list, or null>","confidence":<number 0..1>,"message":"<one short sentence shown to the user in Notion>"}');
    expect(p).toContain('AVAILABLE AGENTS:');
    expect(p).toContain('### emilien');
  });

  it('omits TASK CONTEXT and RE-TRIAGE NOTE when absent', () => {
    const p = buildTriagePrompt(triageInput());
    expect(p).not.toContain('TASK CONTEXT:');
    expect(p).not.toContain('RE-TRIAGE NOTE:');
  });

  it('renders TASK CONTEXT with only the non-empty lines', () => {
    const p = buildTriagePrompt(triageInput({
      taskContext: { status: 'Backlog', body: 'Clean up the onboarding flow steps.', projectName: 'Flowboard', projectObjective: 'Activate users' },
    }));
    expect(p).toContain('TASK CONTEXT:');
    expect(p).toContain('Status: Backlog');
    expect(p).toContain('Project: Flowboard — Objective: Activate users');
    expect(p).toContain('Clean up the onboarding flow steps.');
    expect(p).not.toContain('KPIs / success criteria:');
  });

  it('renders the RE-TRIAGE NOTE when set', () => {
    const p = buildTriagePrompt(triageInput({ retriageNote: '@lili already timed out on this exact work' }));
    expect(p).toContain('RE-TRIAGE NOTE: @lili already timed out on this exact work');
  });

  it('says "(no agents registered)" on an empty roster', () => {
    expect(buildTriagePrompt(triageInput({ candidates: [] }))).toContain('(no agents registered)');
  });
});

const withHumans: TriageCandidate[] = [
  ...candidates,
  { name: 'Greg', kind: 'human', specialty: 'partnerships, golf domain', capabilities: 'review' },
];

describe('buildTriagePrompt — human candidates', () => {
  it('renders humans in a separate LAST RESORT section with the suggest-only rules', () => {
    const p = buildTriagePrompt(triageInput({ candidates: withHumans }));
    expect(p).toContain('HUMAN TEAM MEMBERS (LAST RESORT ONLY):');
    expect(p).toContain('### Greg');
    expect(p).toContain('ALWAYS prefer an AI agent');
    expect(p).toContain('MUST be "suggest" (never "route")');
    // Agents stay in their own section, before the humans.
    expect(p.indexOf('### emilien')).toBeLessThan(p.indexOf('HUMAN TEAM MEMBERS'));
  });

  it('omits the human section and rules when no humans are in the roster', () => {
    const p = buildTriagePrompt(triageInput());
    expect(p).not.toContain('HUMAN TEAM MEMBERS');
    expect(p).not.toContain('LAST RESORT');
  });

  it('renders an agent-less roster with humans only', () => {
    const p = buildTriagePrompt(triageInput({ candidates: withHumans.filter(c => c.kind === 'human') }));
    expect(p).toContain('(no agents registered)');
    expect(p).toContain('### Greg');
  });
});

describe('parseDecision — human candidates', () => {
  it('downgrades a "route" on a human to "suggest" (hard guarantee)', () => {
    const d = parseDecision('{"decision":"route","agent":"Greg","confidence":0.9,"message":"only Greg can sign this"}', withHumans);
    expect(d).toEqual({ decision: 'suggest', agent: 'Greg', confidence: 0.9, message: 'only Greg can sign this' });
  });

  it('keeps a plain suggest on a human, and routing to agents is unaffected', () => {
    expect(parseDecision('{"decision":"suggest","agent":"greg","confidence":0.4,"message":"x"}', withHumans).agent).toBe('Greg');
    expect(parseDecision('{"decision":"route","agent":"dimi","confidence":0.8,"message":"x"}', withHumans).decision).toBe('route');
  });
});

describe('parseAssessment', () => {
  it('parses a blocked outcome with the need', () => {
    const a = parseAssessment('{"outcome":"blocked","need":"DB credentials","message":"can\'t reach the database"}');
    expect(a.outcome).toBe('blocked');
    expect(a.need).toBe('DB credentials');
  });

  it('treats completed (and anything non-blocked) as completed', () => {
    expect(parseAssessment('{"outcome":"completed"}').outcome).toBe('completed');
    expect(parseAssessment('prose, no json').outcome).toBe('completed');
    expect(parseAssessment('{"outcome":"weird"}').outcome).toBe('completed');
  });
});

describe('parseTaskWorthy', () => {
  it('parses a task-worthy request with a title', () => {
    const t = parseTaskWorthy('{"task":true,"title":"Draft the launch plan","kpis":"ship by Fri"}');
    expect(t.task).toBe(true);
    expect(t.title).toBe('Draft the launch plan');
    expect(t.kpis).toBe('ship by Fri');
  });

  it('defaults to not-a-task on false or garbage', () => {
    expect(parseTaskWorthy('{"task":false}').task).toBe(false);
    expect(parseTaskWorthy('no json here').task).toBe(false);
  });
});

describe('parseProjectInference', () => {
  it('parses a confident project pick', () => {
    const r = parseProjectInference('{"project":"PGT v2.0","confidence":0.95}');
    expect(r).toEqual({ project: 'PGT v2.0', confidence: 0.95 });
  });

  it('clamps confidence and tolerates surrounding prose', () => {
    expect(parseProjectInference('here:\n{"project":"lutai","confidence":1.4}\n')).toEqual({ project: 'lutai', confidence: 1 });
  });

  it('treats a null/empty project as no match', () => {
    expect(parseProjectInference('{"project":null,"confidence":0.2}')).toEqual({ project: null, confidence: 0.2 });
    expect(parseProjectInference('{"project":"null","confidence":0.3}')).toEqual({ project: null, confidence: 0.3 });
    expect(parseProjectInference('{"project":"","confidence":0.1}')).toEqual({ project: null, confidence: 0.1 });
  });

  it('defaults to no match on garbage', () => {
    expect(parseProjectInference('not json')).toEqual({ project: null, confidence: 0 });
  });
});

describe('parseBusinessTasks', () => {
  it('parses a JSON array of proposals, skipping titleless entries', () => {
    const out = parseBusinessTasks('[{"title":"Launch beta","rationale":"momentum","kpis":"50 signups"},{"rationale":"no title"}]');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ title: 'Launch beta', rationale: 'momentum', kpis: '50 signups' });
  });

  it('tolerates surrounding prose and returns [] on garbage', () => {
    expect(parseBusinessTasks('Here:\n[{"title":"X"}]\nthanks')).toEqual([{ title: 'X' }]);
    expect(parseBusinessTasks('no array at all')).toEqual([]);
  });

  it('parses a valid recurring routine with cadence + first date', () => {
    const out = parseBusinessTasks('[{"title":"Weekly retro","rationale":"cadence","kpis":"","recurrence":"Weekly","scheduledFor":"2026-06-15"}]');
    expect(out[0]).toEqual({ title: 'Weekly retro', rationale: 'cadence', kpis: '', recurrence: 'Weekly', scheduledFor: '2026-06-15' });
  });

  it('drops an invalid recurrence — the entry stays a one-shot', () => {
    const out = parseBusinessTasks('[{"title":"Do X","recurrence":"Yearly","scheduledFor":"2026-06-15"}]');
    expect(out[0]).toEqual({ title: 'Do X' }); // recurrence dropped → scheduledFor not carried either
  });

  it('drops a non-positive / non-numeric repeatEveryDays but keeps repeatEveryDays when valid', () => {
    expect(parseBusinessTasks('[{"title":"A","repeatEveryDays":"3","scheduledFor":"2026-06-15"}]')[0]).toEqual({ title: 'A' });
    expect(parseBusinessTasks('[{"title":"B","repeatEveryDays":0}]')[0]).toEqual({ title: 'B' });
    expect(parseBusinessTasks('[{"title":"C","repeatEveryDays":3,"scheduledFor":"2026-06-15"}]')[0]).toEqual({ title: 'C', repeatEveryDays: 3, scheduledFor: '2026-06-15' });
  });

  it('ignores a malformed scheduledFor (non-ISO) on a routine', () => {
    const out = parseBusinessTasks('[{"title":"D","recurrence":"Daily","scheduledFor":"next monday"}]');
    expect(out[0]).toEqual({ title: 'D', recurrence: 'Daily' }); // routine kept, bad date dropped
  });
});
