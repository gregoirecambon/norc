import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations, db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { parseSlackMentions, slackAnchorId, isSlackAnchor, parseSlackAnchor } from '../lib/slack-orchestrator.js';
import { extractChannelId } from '../lib/slack-client.js';

const BOT = 'U0BOT';

function addAgent(id: string, name: string, opts: { slackEnabled?: boolean; slackUsergroupId?: string } = {}) {
  db.insert(agents).values({
    id, name, adapterType: 'http', adapterConfig: '{}', status: 'untested',
    registeredAt: Date.now(), metadata: '{}', orgDbPageId: `org-${id}`,
    slackEnabled: opts.slackEnabled ?? true,
    slackUsergroupId: opts.slackUsergroupId ?? null,
  }).run();
}

beforeAll(() => { runMigrations(); });

beforeEach(() => {
  db.delete(agents).run();
  addAgent('a1', 'Research Agent', { slackUsergroupId: 'S0RESEARCH' });
  addAgent('a2', 'Coder');
});

describe('slack anchor ids', () => {
  it('round-trips channel + thread', () => {
    const id = slackAnchorId('C0123', '1718000000.000100');
    expect(isSlackAnchor(id)).toBe(true);
    expect(parseSlackAnchor(id)).toEqual({ channel: 'C0123', threadTs: '1718000000.000100' });
  });

  it('rejects notion page ids', () => {
    expect(isSlackAnchor('8a4f2c1e-1234-5678-9abc-def012345678')).toBe(false);
    expect(parseSlackAnchor('8a4f2c1e-1234')).toBe(null);
  });
});

describe('parseSlackMentions', () => {
  it('detects a bot mention and strips the token', () => {
    const p = parseSlackMentions(`<@${BOT}> what is the status?`, BOT);
    expect(p.norc).toBe(true);
    expect(p.agents).toHaveLength(0);
    expect(p.request).toBe('what is the status?');
  });

  it('resolves the "@Norc AgentName …" fallback (longest name wins)', () => {
    const p = parseSlackMentions(`<@${BOT}> Research Agent summarize the doc`, BOT);
    expect(p.agents.map(a => a.name)).toEqual(['Research Agent']);
    expect(p.request).toBe('summarize the doc');
  });

  it('matches the agent name case-insensitively with separators', () => {
    const p = parseSlackMentions(`<@${BOT}> coder: fix the build`, BOT);
    expect(p.agents.map(a => a.name)).toEqual(['Coder']);
    expect(p.request).toBe('fix the build');
  });

  it('does not target an agent without a bot mention', () => {
    const p = parseSlackMentions('Coder fix the build', BOT);
    expect(p.norc).toBe(false);
    expect(p.agents).toHaveLength(0);
  });

  it('treats DMs as addressed to NORC without a mention token', () => {
    const p = parseSlackMentions('Coder fix the build', BOT, true);
    expect(p.norc).toBe(true);
    expect(p.agents.map(a => a.name)).toEqual(['Coder']);
    expect(p.request).toBe('fix the build');
  });

  it('ignores unknown subteam tokens and keeps the request clean', () => {
    const p = parseSlackMentions(`<!subteam^S99NOPE|@ghost> please help <@${BOT}>`, BOT);
    expect(p.agents).toHaveLength(0);
    expect(p.norc).toBe(true);
    expect(p.request).toBe('please help');
  });

  it('handles a null botUserId without matching anything', () => {
    const p = parseSlackMentions(`<@${BOT}> hello`, null);
    expect(p.norc).toBe(false);
    expect(p.request).toBe('hello');
  });

  it('resolves a subteam (user-group) token to its agent', () => {
    const p = parseSlackMentions('<!subteam^S0RESEARCH|@research-agent> dig into Acme', BOT);
    expect(p.agents.map(a => a.name)).toEqual(['Research Agent']);
    expect(p.request).toBe('dig into Acme');
  });

  it('ignores agents whose Slack toggle is off', () => {
    db.delete(agents).run();
    addAgent('a3', 'Hidden Agent', { slackEnabled: false, slackUsergroupId: 'S0HIDDEN' });
    const bySubteam = parseSlackMentions('<!subteam^S0HIDDEN|@hidden-agent> hi', BOT);
    expect(bySubteam.agents).toHaveLength(0);
    const byName = parseSlackMentions(`<@${BOT}> Hidden Agent hi`, BOT);
    expect(byName.agents).toHaveLength(0);
  });

  it('unwraps channel tokens, keeping the id usable for /slack', () => {
    const named = parseSlackMentions(`<@${BOT}> post a brief in <#C0B6KGCA3PE|app-lutai>`, BOT);
    expect(named.request).toBe('post a brief in #app-lutai (channel id C0B6KGCA3PE)');
    const bare = parseSlackMentions(`<@${BOT}> send a message in <#C0B6KGCA3PE>`, BOT);
    expect(bare.request).toBe('send a message in channel C0B6KGCA3PE');
  });
});

describe('extractChannelId', () => {
  it('accepts every decoration agents pass', () => {
    expect(extractChannelId('C0B6KGCA3PE')).toBe('C0B6KGCA3PE');
    expect(extractChannelId('#C0B6KGCA3PE')).toBe('C0B6KGCA3PE');
    expect(extractChannelId('<#C0B6KGCA3PE>')).toBe('C0B6KGCA3PE');
    expect(extractChannelId('<#C0B6KGCA3PE|app-lutai>')).toBe('C0B6KGCA3PE');
    expect(extractChannelId(' <#C0B6KGCA3PE|app-lutai> ')).toBe('C0B6KGCA3PE');
  });

  it('returns null for names (resolved via conversations.list instead)', () => {
    expect(extractChannelId('app-lutai')).toBe(null);
    expect(extractChannelId('#app-lutai')).toBe(null);
    expect(extractChannelId('')).toBe(null);
  });
});
