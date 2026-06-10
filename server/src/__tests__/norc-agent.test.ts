import { describe, it, expect } from 'vitest';
import { buildNorcPrompt, parseNorcDecision, type NorcTurnInput } from '../lib/norc-agent.js';

function input(extra: Partial<NorcTurnInput> = {}): NorcTurnInput {
  return {
    provider: 'anthropic', apiKey: 'k', model: 'm',
    request: 'What is everyone working on?',
    conversation: [],
    anchorKind: 'task', anchorTitle: 'Weekly ops',
    workspace: {
      agents: [{ name: 'alpha', specialty: 'backend', capabilities: 'code', activeRuns: 1, queuedCount: 0, maxConcurrentRuns: 2 }],
      humans: [{ name: 'Greg', specialty: 'partnerships' }],
      openTasks: [{ id: 'task-1', title: 'Ship onboarding', status: 'In Progress', assignee: 'alpha' }],
      activeRuns: 1, queuedTurns: 0,
      settings: { autoRouteThreshold: 0.7, autoProposeEnabled: false, autoProposeIntervalHours: 12, orchestratorSystemPrompt: null },
    },
    ...extra,
  };
}

describe('buildNorcPrompt', () => {
  it('includes the request, rosters, open tasks, load, and own configuration', () => {
    const p = buildNorcPrompt(input());
    expect(p).toContain('REQUEST:');
    expect(p).toContain('What is everyone working on?');
    expect(p).toContain('### alpha');
    expect(p).toContain('- Greg — partnerships');
    expect(p).toContain('[task-1] "Ship onboarding" (In Progress) — assigned to alpha');
    expect(p).toContain('LOAD: 1 run(s) in flight, 0 turn(s) queued.');
    expect(p).toContain('autoRouteThreshold: 0.7');
    expect(p).toContain('(default — not customized)');
  });

  it('documents every action type and the approval rule for self-changes', () => {
    const p = buildNorcPrompt(input());
    for (const t of ['assign_task', 'triage_task', 'set_task_status', 'propose_tasks', 'nudge_agent', 'propose_self_change']) {
      expect(p).toContain(`"type":"${t}"`);
    }
    expect(p).toContain('applied only after human approval');
  });

  it('renders empty rosters/tasks explicitly', () => {
    const p = buildNorcPrompt(input({
      workspace: { ...input().workspace, agents: [], humans: [], openTasks: [] },
    }));
    expect(p).toContain('(no agents registered)');
    expect(p).toContain('(no open tasks)');
  });
});

describe('parseNorcDecision', () => {
  it('parses a clean decision with valid actions', () => {
    const d = parseNorcDecision(JSON.stringify({
      reply: 'On it.',
      actions: [
        { type: 'assign_task', taskPageId: 'task-1', assignee: 'alpha' },
        { type: 'set_task_status', taskPageId: 'task-2', status: 'Blocked' },
        { type: 'nudge_agent', agentName: 'alpha', message: 'status update please' },
      ],
    }));
    expect(d.reply).toBe('On it.');
    expect(d.actions).toHaveLength(3);
    expect(d.actions[0]).toEqual({ type: 'assign_task', taskPageId: 'task-1', assignee: 'alpha' });
  });

  it('drops unknown action types and invalid payloads, keeps the rest', () => {
    const d = parseNorcDecision(JSON.stringify({
      reply: 'mixed bag',
      actions: [
        { type: 'rm_rf_workspace' },                                  // unknown
        { type: 'set_task_status', taskPageId: 't', status: 'Queued' }, // status not in NORC whitelist
        { type: 'assign_task', taskPageId: '', assignee: 'alpha' },     // missing id
        { type: 'triage_task', taskPageId: 'task-9' },                  // valid
        { type: 'propose_self_change', kind: 'sudoMode', payload: { value: 1 } }, // unknown kind
      ],
    }));
    expect(d.actions).toEqual([{ type: 'triage_task', taskPageId: 'task-9' }]);
  });

  it('caps actions at 5', () => {
    const actions = Array.from({ length: 9 }, (_, i) => ({ type: 'triage_task', taskPageId: `t-${i}` }));
    const d = parseNorcDecision(JSON.stringify({ reply: 'x', actions }));
    expect(d.actions).toHaveLength(5);
  });

  it('validates propose_tasks entries and drops titleless ones', () => {
    const d = parseNorcDecision(JSON.stringify({
      reply: 'x',
      actions: [{ type: 'propose_tasks', tasks: [{ title: 'Do A', kpis: 'done' }, { description: 'no title' }] }],
    }));
    expect(d.actions).toEqual([{ type: 'propose_tasks', tasks: [{ title: 'Do A', kpis: 'done' }] }]);
  });

  it('accepts a valid propose_self_change and keeps its payload + rationale', () => {
    const d = parseNorcDecision(JSON.stringify({
      reply: 'proposing',
      actions: [{ type: 'propose_self_change', kind: 'autoRouteThreshold', payload: { value: 0.9 }, rationale: 'fewer false routes' }],
    }));
    expect(d.actions).toEqual([{
      type: 'propose_self_change', kind: 'autoRouteThreshold', payload: { value: 0.9 }, rationale: 'fewer false routes',
    }]);
  });

  it('degrades garbage to a plain reply with no actions', () => {
    const d = parseNorcDecision('I am terribly sorry, no JSON today.');
    expect(d.actions).toEqual([]);
    expect(d.reply).toContain('no JSON today');
    expect(parseNorcDecision('').actions).toEqual([]);
  });
});
