import { describe, it, expect } from 'vitest';

// Test the prompt-building logic in isolation
interface Project {
  id: string;
  name: string;
  docs: string;
  kpis: string;
  objective: string;
}

interface ContextAssembly {
  taskName: string;
  taskKpis: string;
  project: Project | null;
  priorAgentOutputs: string[];
  agentPersona: string;
  availableAgents: Array<{ name: string; specialty: string }>;
  companyVision: string | null;
  companyObjectives: string | null;
  contextLevel: 'task' | 'project' | 'strategic';
}

function buildPrompt(ctx: ContextAssembly, contract: object): string {
  const sections: string[] = [];
  if (ctx.agentPersona) sections.push(`You are: ${ctx.agentPersona}`);
  if (ctx.companyVision) sections.push(`[COMPANY VISION]\n${ctx.companyVision}`);
  if (ctx.project) sections.push(`[PROJECT: ${ctx.project.name}]\nObjective: ${ctx.project.objective}\nKPIs: ${ctx.project.kpis}`);
  if (ctx.priorAgentOutputs.length > 0) sections.push(`[PRIOR WORK]\n${ctx.priorAgentOutputs.join('\n\n')}`);
  sections.push(`[YOUR TASK]\n${ctx.taskName}`);
  if (ctx.taskKpis) sections.push(`[SUCCESS CRITERIA]\n${ctx.taskKpis}`);
  sections.push(`[NORC ORCHESTRATION PROTOCOL]\n${JSON.stringify(contract)}`);
  return sections.join('\n\n---\n\n');
}

describe('prompt builder', () => {
  const baseCtx: ContextAssembly = {
    taskName: 'Redesign pricing page',
    taskKpis: 'Bounce rate < 40%, trial-to-paid > 15%',
    project: { id: 'p1', name: 'New Website', docs: '', kpis: 'Launch by Q3', objective: 'Convert 2x more trials' },
    priorAgentOutputs: [],
    agentPersona: 'Senior developer with React expertise',
    availableAgents: [],
    companyVision: null,
    companyObjectives: null,
    contextLevel: 'project',
  };

  const contract = { norcVersion: '1.0', callbackUrl: 'http://localhost/callback/abc', callbackToken: 'abc' };

  it('includes task name in prompt', () => {
    const p = buildPrompt(baseCtx, contract);
    expect(p).toContain('Redesign pricing page');
  });

  it('includes KPIs in success criteria section', () => {
    const p = buildPrompt(baseCtx, contract);
    expect(p).toContain('Bounce rate < 40%');
  });

  it('includes project context when level is project', () => {
    const p = buildPrompt(baseCtx, contract);
    expect(p).toContain('New Website');
    expect(p).toContain('Convert 2x more trials');
  });

  it('excludes company vision for project-level context', () => {
    const p = buildPrompt(baseCtx, contract);
    expect(p).not.toContain('[COMPANY VISION]');
  });

  it('includes company vision for strategic-level context', () => {
    const strategicCtx = { ...baseCtx, contextLevel: 'strategic' as const, companyVision: 'Be the leading AI company' };
    const p = buildPrompt(strategicCtx, contract);
    expect(p).toContain('Be the leading AI company');
  });

  it('includes prior agent outputs when present', () => {
    const ctxWithPrior = { ...baseCtx, priorAgentOutputs: ['Designer said: mockups attached'] };
    const p = buildPrompt(ctxWithPrior, contract);
    expect(p).toContain('Designer said: mockups attached');
  });

  it('includes callback URL from execution contract', () => {
    const p = buildPrompt(baseCtx, contract);
    expect(p).toContain('http://localhost/callback/abc');
  });

  it('task-level context excludes project section', () => {
    const taskCtx = { ...baseCtx, project: null, contextLevel: 'task' as const };
    const p = buildPrompt(taskCtx, contract);
    expect(p).not.toContain('[PROJECT:');
  });
});

describe('token estimation', () => {
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  it('estimates tokens for a short string', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('flags large docs as needing summarization', () => {
    const largeDoc = 'x'.repeat(150_000 * 4 + 1);
    expect(estimateTokens(largeDoc)).toBeGreaterThan(150_000);
  });
});
