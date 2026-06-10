import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/notion-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notion-client.js')>()),
  notionGet: vi.fn(),
}));
vi.mock('../lib/notion-anchor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notion-anchor.js')>()),
  readPageMarkdown: vi.fn(),
}));

import { notionGet } from '../lib/notion-client.js';
import { readPageMarkdown } from '../lib/notion-anchor.js';
import { parseAgentProfile, enrichCandidates, clearTriageContextCache } from '../lib/triage-context.js';

const rt = (text: string) => [{ plain_text: text }];

function agentProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Name': { type: 'title', title: rt('lili') },
    'Specialty': { type: 'rich_text', rich_text: rt('onboarding flows') },
    'Capabilities': { type: 'rich_text', rich_text: rt('Flowboard, funnels') },
    'Technology': { type: 'select', select: { name: 'Claude Code' } },
    'System Prompt': { type: 'rich_text', rich_text: rt('You are lili. Always be terse.') },
    'Status': { type: 'select', select: { name: 'Available' } },
    'Empty notes': { type: 'rich_text', rich_text: [] },
    ...over,
  };
}

describe('parseAgentProfile', () => {
  it('extracts the mapped fields and dumps other non-empty properties', () => {
    const p = parseAgentProfile(agentProps(), 'Owns the onboarding funnel end to end.');
    expect(p.specialty).toBe('onboarding flows');
    expect(p.capabilities).toBe('Flowboard, funnels');
    expect(p.technology).toBe('Claude Code');
    expect(p.description).toBe('Owns the onboarding funnel end to end.');
    expect(p.properties).toEqual([{ name: 'Status', value: 'Available' }]); // Name/System Prompt/mapped/empty excluded
  });

  it('falls back to a labeled System Prompt excerpt only when the body is empty', () => {
    const withBody = parseAgentProfile(agentProps(), 'real bio');
    expect(withBody.description).toBe('real bio');
    const noBody = parseAgentProfile(agentProps(), '   ');
    expect(noBody.description).toBe('(from persona) You are lili. Always be terse.');
  });

  it('caps the body excerpt at 700 chars and the persona fallback at 300', () => {
    const long = parseAgentProfile(agentProps(), 'x'.repeat(2000));
    expect(long.description).toHaveLength(700);
    const persona = parseAgentProfile(agentProps({ 'System Prompt': { type: 'rich_text', rich_text: rt('y'.repeat(2000)) } }), '');
    expect(persona.description).toBe(`(from persona) ${'y'.repeat(300)}`);
  });

  it('tolerates missing/garbage properties', () => {
    const p = parseAgentProfile(null, '');
    expect(p).toEqual({ specialty: '', capabilities: '', technology: '', description: '', properties: [] });
  });
});

describe('enrichCandidates', () => {
  beforeEach(() => {
    clearTriageContextCache();
    vi.mocked(notionGet).mockReset();
    vi.mocked(readPageMarkdown).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('prefers Notion values over registration metadata and attaches the description', async () => {
    vi.mocked(notionGet).mockResolvedValue({ properties: agentProps() });
    vi.mocked(readPageMarkdown).mockResolvedValue('Onboarding specialist.');
    const out = await enrichCandidates('key', [
      { name: 'lili', specialty: 'stale metadata', capabilities: '', orgDbPageId: 'page-1' },
    ]);
    expect(out[0]).toMatchObject({
      name: 'lili',
      specialty: 'onboarding flows',
      capabilities: 'Flowboard, funnels',
      technology: 'Claude Code',
      description: 'Onboarding specialist.',
      properties: [{ name: 'Status', value: 'Available' }],
    });
    expect(out[0]).not.toHaveProperty('orgDbPageId');
  });

  it('keeps the metadata-only candidate when the Notion read fails or there is no page', async () => {
    vi.mocked(notionGet).mockRejectedValue(new Error('boom'));
    const out = await enrichCandidates('key', [
      { name: 'a', specialty: 'meta-spec', capabilities: 'meta-cap', orgDbPageId: 'page-a' },
      { name: 'b', specialty: 's', capabilities: 'c', orgDbPageId: null },
    ]);
    expect(out[0]).toMatchObject({ name: 'a', specialty: 'meta-spec', capabilities: 'meta-cap' });
    expect(out[1]).toMatchObject({ name: 'b', specialty: 's' });
    expect(notionGet).toHaveBeenCalledTimes(1); // only the candidate with a page
  });

  it('caches profiles within the TTL and refetches after expiry', async () => {
    vi.mocked(notionGet).mockResolvedValue({ properties: agentProps() });
    vi.mocked(readPageMarkdown).mockResolvedValue('bio');
    const c = [{ name: 'lili', specialty: '', capabilities: '', orgDbPageId: 'page-1' }];
    await enrichCandidates('key', c);
    await enrichCandidates('key', c);
    expect(notionGet).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await enrichCandidates('key', c);
    expect(notionGet).toHaveBeenCalledTimes(2);
  });
});
