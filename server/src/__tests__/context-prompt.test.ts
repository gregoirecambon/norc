import { describe, it, expect } from 'vitest';
import { getTitle, getRichText, getSelect, getRelationIds } from '../lib/notion-props.js';
import { buildPrompt, type AssembledContext } from '../lib/context-assembler.js';
import { wantsContent } from '../lib/orchestrator.js';
import type { Anchor } from '../lib/notion-anchor.js';

describe('wantsContent', () => {
  it('detects content-production requests (en + fr)', () => {
    for (const r of [
      'Write a summary of this page',
      'Please draft the intro section',
      'Create a doc outlining the plan',
      'rédige une note de synthèse',
      'ajoute un paragraphe sur les risques',
    ]) expect(wantsContent(r), r).toBe(true);
  });

  it('treats questions / feedback as comments, not content', () => {
    for (const r of [
      'What do you think of this?',
      'Is this approach correct?',
      'Can you review this and tell me your opinion?',
      'thoughts?',
    ]) expect(wantsContent(r), r).toBe(false);
  });
});

const rt = (s: string) => [{ type: 'text', text: { content: s }, plain_text: s }];

describe('notion-props extractors', () => {
  const props = {
    'Name': { type: 'title', title: rt('Redesign pricing page') },
    'Objective': { type: 'rich_text', rich_text: rt('Convert 2x more trials') },
    'Status': { type: 'select', select: { name: 'In Progress' } },
    'Project': { type: 'relation', relation: [{ id: 'proj-1' }] },
    'Empty': { type: 'rich_text', rich_text: [] },
  };

  it('reads title / rich_text / select / relation', () => {
    expect(getTitle(props, 'Name')).toBe('Redesign pricing page');
    expect(getRichText(props, 'Objective')).toBe('Convert 2x more trials');
    expect(getSelect(props, 'Status')).toBe('In Progress');
    expect(getRelationIds(props, 'Project')).toEqual(['proj-1']);
  });

  it('returns safe empties for missing / wrong-typed props', () => {
    expect(getTitle(props, 'Nope')).toBe('');
    expect(getRichText(props, 'Empty')).toBe('');
    expect(getSelect(props, 'Name')).toBeNull();
    expect(getRelationIds(props, 'Status')).toEqual([]);
    expect(getTitle(undefined, 'Name')).toBe('');
  });
});

describe('buildPrompt', () => {
  const taskAnchor = { kind: 'task', pageId: 'task-1', page: {}, parentDatabaseId: 'tasks-db' } as Anchor;

  const ctx: AssembledContext = {
    contextLevel: 'project',
    systemPrompt: 'You are the Developer Agent.',
    taskBlock: { name: 'Build login', status: 'In Progress', kpis: 'tests pass', priorOutput: '', lastCheckpoint: '' },
    projectBlock: { name: 'Auth', objective: 'Ship SSO', kpis: 'p95 < 200ms', docs: '' },
    fingerprint: 'fp',
  };

  it('returns the system prompt separately and includes all relevant sections', () => {
    const { system, prompt } = buildPrompt({
      ctx, anchor: taskAnchor,
      priorComments: [{ authorId: 'u1', plainText: 'first take please' }],
      request: 'Implement the login form',
      availableAgents: ['Designer Agent'],
    });
    expect(system).toBe('You are the Developer Agent.');
    expect(prompt).toContain('[CONTEXT — level: project]');
    expect(prompt).toContain('Objective: Ship SSO');
    expect(prompt).toContain('[TASK]');
    expect(prompt).toContain('Task: Build login');
    expect(prompt).toContain('[CONVERSATION SO FAR]');
    expect(prompt).toContain('first take please');
    expect(prompt).toContain('[REQUEST]\nImplement the login form');
    expect(prompt).toContain('Designer Agent');
  });

  it('includes a compact [NORC RUN] block when provided, and no repeated contract/instructions', () => {
    const { prompt } = buildPrompt({
      ctx, anchor: taskAnchor,
      priorComments: [], request: 'go', availableAgents: [],
      runBlock: 'run_id: r1\nnotion_page_id: task-1\napi_base: https://norc/api/runs/tok',
    });
    expect(prompt).toContain('[NORC RUN]');
    expect(prompt).toContain('notion_page_id: task-1');
    expect(prompt).toContain('api_base: https://norc/api/runs/tok');
    // The static protocol now lives in the agent's skill, not every prompt.
    expect(prompt).not.toContain('[EXECUTION CONTRACT]');
    expect(prompt).not.toContain('[INSTRUCTIONS]');
  });

  it('includes the page reference and commented-on text on a free page', () => {
    const pageAnchor = { kind: 'page', pageId: 'p1', page: {}, parentDatabaseId: null } as Anchor;
    const { prompt } = buildPrompt({
      ctx: { contextLevel: 'project', systemPrompt: 'sp', taskBlock: null, projectBlock: null, fingerprint: 'x' },
      anchor: pageAnchor,
      priorComments: [], request: 'what do you think?', availableAgents: [],
      commentedText: 'The pricing should be $9/mo',
      pageRef: { title: 'Pricing notes', url: 'https://notion.so/p1', firstVisit: true },
    });
    expect(prompt).toContain('[PAGE]');
    expect(prompt).toContain('Title: Pricing notes');
    expect(prompt).toContain('Link: https://notion.so/p1');
    expect(prompt).toContain("haven't worked on this page before");
    expect(prompt).toContain('[COMMENTED-ON TEXT]');
    expect(prompt).toContain('The pricing should be $9/mo');
  });

  it('omits first-visit note for a returning agent and omits page section otherwise', () => {
    const pageAnchor = { kind: 'page', pageId: 'p1', page: {}, parentDatabaseId: null } as Anchor;
    const { prompt } = buildPrompt({
      ctx: { contextLevel: 'project', systemPrompt: 'sp', taskBlock: null, projectBlock: null, fingerprint: 'x' },
      anchor: pageAnchor, priorComments: [], request: 'hi', availableAgents: [],
      pageRef: { title: 'Pricing notes', url: null, firstVisit: false },
    });
    expect(prompt).toContain('[PAGE]');
    expect(prompt).not.toContain("haven't worked on this page before");
    expect(prompt).not.toContain('Link:');
  });

  it('omits the run block when not provided', () => {
    const { prompt } = buildPrompt({
      ctx, anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(prompt).not.toContain('[NORC RUN]');
  });

  it('omits task/conversation/agents sections when empty', () => {
    const { prompt } = buildPrompt({
      ctx: { contextLevel: 'task', systemPrompt: 'sp', taskBlock: null, projectBlock: null, fingerprint: 'x' },
      anchor: { kind: 'page', pageId: 'p', page: {}, parentDatabaseId: null } as Anchor,
      priorComments: [],
      request: 'hello',
      availableAgents: [],
    });
    expect(prompt).not.toContain('[TASK]');
    expect(prompt).not.toContain('[CONVERSATION SO FAR]');
    expect(prompt).not.toContain('[AVAILABLE AGENTS]');
    expect(prompt).toContain('[REQUEST]\nhello');
  });
});
