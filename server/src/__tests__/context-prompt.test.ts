import { describe, it, expect } from 'vitest';
import { getTitle, getRichText, getSelect, getRelationIds } from '../lib/notion-props.js';
import { buildPrompt, matchResourcesByName, type AssembledContext } from '../lib/context-assembler.js';
import { wantsContent } from '../lib/orchestrator.js';
import type { Anchor, ResourceRef } from '../lib/notion-anchor.js';

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
    companyBlocks: [],
    relatedBlocks: [],
    projectResources: [],
    inlinedResources: [],
    bodyMarkdown: '',
    projectBody: '',
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
      ctx: { contextLevel: 'project', systemPrompt: 'sp', taskBlock: null, projectBlock: null, companyBlocks: [], relatedBlocks: [], projectResources: [], inlinedResources: [], bodyMarkdown: '', projectBody: '', fingerprint: 'x' },
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
      ctx: { contextLevel: 'project', systemPrompt: 'sp', taskBlock: null, projectBlock: null, companyBlocks: [], relatedBlocks: [], projectResources: [], inlinedResources: [], bodyMarkdown: '', projectBody: '', fingerprint: 'x' },
      anchor: pageAnchor, priorComments: [], request: 'hi', availableAgents: [],
      pageRef: { title: 'Pricing notes', url: null, firstVisit: false },
    });
    expect(prompt).toContain('[PAGE]');
    expect(prompt).not.toContain("haven't worked on this page before");
    expect(prompt).not.toContain('Link:');
  });

  it('renders [STRATEGIC CONTEXT] when company blocks are present', () => {
    const { prompt } = buildPrompt({
      ctx: {
        contextLevel: 'strategic', systemPrompt: 'sp', taskBlock: null, projectBlock: null,
        companyBlocks: [{ name: 'North Star', type: 'Vision', content: 'Be the open Notion agent layer' }],
        relatedBlocks: [], projectResources: [], inlinedResources: [], bodyMarkdown: '', projectBody: '',
        fingerprint: 'x',
      },
      anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(prompt).toContain('[STRATEGIC CONTEXT]');
    expect(prompt).toContain('(Vision) North Star: Be the open Notion agent layer');
  });

  it('omits [STRATEGIC CONTEXT] when there are no company blocks', () => {
    const { prompt } = buildPrompt({
      ctx, anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(prompt).not.toContain('[STRATEGIC CONTEXT]');
  });

  it('includes [PAGE CONTENT] when a page body is present, and renders author names', () => {
    const { prompt } = buildPrompt({
      ctx: { ...ctx, bodyMarkdown: '# Heading\n- a nested point' },
      anchor: taskAnchor,
      priorComments: [{ authorId: 'u1', authorName: 'Alice', plainText: 'first take please' }],
      request: 'go', availableAgents: [],
    });
    expect(prompt).toContain('[PAGE CONTENT]');
    expect(prompt).toContain('# Heading');
    expect(prompt).toContain('- Alice: first take please');
  });

  it('renders [RELATED] rows with fetchable pageIds for strategic agents', () => {
    const { prompt } = buildPrompt({
      ctx: { ...ctx, contextLevel: 'strategic', relatedBlocks: [{ relation: 'Meetings', name: 'Q3 Planning', summary: 'decided to ship SSO', id: 'rel-1' }] },
      anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(prompt).toContain('[RELATED]');
    expect(prompt).toContain('(Meetings) Q3 Planning');
    expect(prompt).toContain('pageId: rel-1');
    expect(prompt).toContain('decided to ship SSO');
  });

  it('renders [PROJECT RESOURCES] with pageIds, and omits the section when empty', () => {
    const withRes = buildPrompt({
      ctx: { ...ctx, projectResources: [
        { id: 'onb-1', title: 'ONBOARDING', kind: 'page' },
        { id: 'db-1', title: 'Specs', kind: 'database' },
      ] },
      anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(withRes.prompt).toContain('[PROJECT RESOURCES]');
    expect(withRes.prompt).toContain('ONBOARDING — pageId: onb-1');
    expect(withRes.prompt).toContain('Specs 🗄 — pageId: db-1');

    const noRes = buildPrompt({ ctx, anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [] });
    expect(noRes.prompt).not.toContain('[PROJECT RESOURCES]');
  });

  it('inlines a [RESOURCE: …] block with its body when present', () => {
    const { prompt } = buildPrompt({
      ctx: { ...ctx, inlinedResources: [{ title: 'ONBOARDING', pageId: 'onb-1', markdown: '1. Welcome\n2. Goals' }] },
      anchor: taskAnchor, priorComments: [], request: 'describe the onboarding', availableAgents: [],
    });
    expect(prompt).toContain('[RESOURCE: ONBOARDING]');
    expect(prompt).toContain('pageId: onb-1');
    expect(prompt).toContain('1. Welcome');
  });

  it('keeps [PROJECT RESOURCES] (high priority) even when bodies overflow the budget', () => {
    const { prompt } = buildPrompt({
      ctx: { ...ctx, bodyMarkdown: 'x'.repeat(60_000), projectResources: [{ id: 'onb-1', title: 'ONBOARDING', kind: 'page' }] },
      anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
      runBlock: 'run_id: r1\napi_base: https://norc/api/runs/tok',
    });
    expect(prompt).toContain('[PROJECT RESOURCES]');
    expect(prompt).toContain('pageId: onb-1');
    expect(prompt).toContain('…(truncated for length)');
  });

  it('keeps [REQUEST] and [NORC RUN] even when low-priority context overflows the budget', () => {
    const huge = 'x'.repeat(60_000);
    const { prompt } = buildPrompt({
      ctx: { ...ctx, bodyMarkdown: huge },
      anchor: taskAnchor, priorComments: [], request: 'THE-REQUEST', availableAgents: [],
      runBlock: 'run_id: r1\napi_base: https://norc/api/runs/tok',
    });
    expect(prompt).toContain('[REQUEST]\nTHE-REQUEST');
    expect(prompt).toContain('[NORC RUN]');
    expect(prompt).toContain('api_base: https://norc/api/runs/tok');
    // The oversized body is truncated so the whole prompt stays bounded.
    expect(prompt).toContain('…(truncated for length)');
    expect(prompt.length).toBeLessThan(30_000);
  });

  it('omits the run block when not provided', () => {
    const { prompt } = buildPrompt({
      ctx, anchor: taskAnchor, priorComments: [], request: 'go', availableAgents: [],
    });
    expect(prompt).not.toContain('[NORC RUN]');
  });

  it('omits task/conversation/agents sections when empty', () => {
    const { prompt } = buildPrompt({
      ctx: { contextLevel: 'task', systemPrompt: 'sp', taskBlock: null, projectBlock: null, companyBlocks: [], relatedBlocks: [], projectResources: [], inlinedResources: [], bodyMarkdown: '', projectBody: '', fingerprint: 'x' },
      anchor: { kind: 'page', pageId: 'p', page: {}, parentDatabaseId: null } as Anchor,
      priorComments: [],
      request: 'hello',
      availableAgents: [],
    });
    expect(prompt).not.toContain('[TASK]');
    expect(prompt).not.toContain('[CONVERSATION SO FAR]');
    expect(prompt).not.toContain('[OTHER AGENTS]');
    expect(prompt).toContain('[REQUEST]\nhello');
  });
});

describe('matchResourcesByName', () => {
  const refs: ResourceRef[] = [
    { id: 'onb-1', title: 'Onboarding', kind: 'page' },
    { id: 'spec-1', title: 'Spec', kind: 'page' },
    { id: 'design-1', title: 'Design Doc', kind: 'page' },
    { id: 'db-1', title: 'Tasks', kind: 'database' },
  ];

  it('matches a resource the request names (case/punctuation-insensitive)', () => {
    const m = matchResourcesByName('please describe the ONBOARDING, how many steps?', refs);
    expect(m.map(r => r.id)).toEqual(['onb-1']);
  });

  it('matches a morphological variant ("the onboard" → Onboarding)', () => {
    const m = matchResourcesByName('how many steps did the onboard contain?', refs);
    expect(m.map(r => r.id)).toEqual(['onb-1']);
  });

  it('matches against the task name portion of the haystack too', () => {
    const m = matchResourcesByName('Review Design Doc  —  the request body', refs);
    expect(m.map(r => r.id)).toContain('design-1');
  });

  it('returns nothing when no resource is named', () => {
    expect(matchResourcesByName('ship the login flow', refs)).toEqual([]);
  });

  it('never matches databases (no readable body to inline)', () => {
    expect(matchResourcesByName('update the Tasks board', refs).map(r => r.id)).not.toContain('db-1');
  });

  it('caps the number of matches', () => {
    const many: ResourceRef[] = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `Topic${i}`, kind: 'page' as const }));
    const hay = many.map(r => r.title).join(' ');
    expect(matchResourcesByName(hay, many, 3).length).toBe(3);
  });
});
