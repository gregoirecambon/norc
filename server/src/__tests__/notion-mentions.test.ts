import { describe, it, expect } from 'vitest';
import {
  extractMentionedPageIds,
  extractRelationPageIds,
  extractPropertyMentionPageIds,
} from '../lib/notion-mentions.js';

// Sample rich_text shapes mirroring Notion's comment/block payloads.
const pageMention = (id: string) => ({
  type: 'mention',
  mention: { type: 'page', page: { id } },
  plain_text: 'Agent',
});
const userMention = (id: string) => ({
  type: 'mention',
  mention: { type: 'user', user: { id } },
  plain_text: '@someone',
});
const plain = (text: string) => ({ type: 'text', text: { content: text }, plain_text: text });

describe('extractMentionedPageIds', () => {
  it('collects page mention ids', () => {
    const rt = [plain('hey '), pageMention('abc-123'), plain(' please look')];
    expect(extractMentionedPageIds(rt)).toEqual(['abc-123']);
  });

  it('collects multiple page mentions in order', () => {
    const rt = [pageMention('p1'), plain(' and '), pageMention('p2')];
    expect(extractMentionedPageIds(rt)).toEqual(['p1', 'p2']);
  });

  it('ignores user mentions and plain text', () => {
    const rt = [plain('hello'), userMention('u1')];
    expect(extractMentionedPageIds(rt)).toEqual([]);
  });

  it('returns [] for non-array / empty / malformed input', () => {
    expect(extractMentionedPageIds(undefined)).toEqual([]);
    expect(extractMentionedPageIds(null)).toEqual([]);
    expect(extractMentionedPageIds([])).toEqual([]);
    expect(extractMentionedPageIds([{ type: 'mention', mention: { type: 'page' } }])).toEqual([]);
  });
});

describe('extractRelationPageIds', () => {
  // Shape mirrors a Notion page's `properties` map.
  const props = {
    'Assigned To': { type: 'relation', relation: [{ id: 'agent-1' }, { id: 'agent-2' }] },
    'Project': { type: 'relation', relation: [{ id: 'proj-1' }] },
    'Status': { type: 'select', select: { name: 'In Progress' } },
    'KPIs': { type: 'rich_text', rich_text: [] },
  };

  it('collects all relation target ids (agent + non-agent alike)', () => {
    expect(extractRelationPageIds(props)).toEqual(['agent-1', 'agent-2', 'proj-1']);
  });

  it('returns [] when there are no relations / bad input', () => {
    expect(extractRelationPageIds({ Status: { type: 'select', select: { name: 'x' } } })).toEqual([]);
    expect(extractRelationPageIds(undefined)).toEqual([]);
    expect(extractRelationPageIds(null)).toEqual([]);
  });
});

describe('extractPropertyMentionPageIds', () => {
  it('finds page mentions inside title and rich_text properties', () => {
    const props = {
      'Name': {
        type: 'title',
        title: [
          { type: 'text', text: { content: 'ping ' }, plain_text: 'ping ' },
          { type: 'mention', mention: { type: 'page', page: { id: 'agent-9' } }, plain_text: 'Agent' },
        ],
      },
      'Notes': {
        type: 'rich_text',
        rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: 'agent-10' } }, plain_text: 'A' }],
      },
      'Project': { type: 'relation', relation: [{ id: 'proj-1' }] },
    };
    expect(extractPropertyMentionPageIds(props)).toEqual(['agent-9', 'agent-10']);
  });

  it('returns [] when no title/rich_text mentions / bad input', () => {
    expect(extractPropertyMentionPageIds({ Status: { type: 'select', select: { name: 'x' } } })).toEqual([]);
    expect(extractPropertyMentionPageIds(undefined)).toEqual([]);
  });
});
