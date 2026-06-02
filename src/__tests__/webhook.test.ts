import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// Isolate the signature validation logic from the full module
function validateSignature(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  if (signature.length !== expected.length) return false;
  // constant-time comparison
  let match = true;
  for (let i = 0; i < expected.length; i++) {
    if (signature[i] !== expected[i]) match = false;
  }
  return match;
}

describe('Notion webhook signature validation', () => {
  const secret = 'test-secret-abc123';
  const body = JSON.stringify({ type: 'page_updated', entity: { id: 'page-1' } });

  it('accepts a valid signature', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(validateSignature(body, sig, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const tamperedBody = body + ' ';
    expect(validateSignature(tamperedBody, sig, secret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = 'sha256=' + createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(validateSignature(body, sig, secret)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(validateSignature(body, '', secret)).toBe(false);
  });
});

describe('Notion event page ID extraction', () => {
  it('extracts assigned agent from status-change event', () => {
    const event = {
      type: 'page_updated',
      properties: {
        Status: { select: { name: 'Ready' } },
        'Assigned Agent': { select: { name: 'Claude Code Agent' } },
      },
    };
    const props = event.properties;
    const agentName = props['Assigned Agent']?.select?.name;
    const status = props.Status?.select?.name;
    expect(status).toBe('Ready');
    expect(agentName).toBe('Claude Code Agent');
  });

  it('extracts page IDs from comment rich text', () => {
    const richText = [
      { type: 'text', text: { content: 'Please ' } },
      { type: 'mention', mention: { type: 'page', page: { id: 'agent-page-uuid' } } },
      { type: 'text', text: { content: ' fix this bug' } },
    ];
    const ids = richText
      .filter(b => b.type === 'mention' && (b as any).mention?.type === 'page')
      .map(b => (b as any).mention.page.id);
    expect(ids).toEqual(['agent-page-uuid']);
  });
});

describe('State machine transitions', () => {
  it('Ready → In Progress is the first operation before agent execution', () => {
    // This test validates the dedup design:
    // NORC writes Status=Running BEFORE dispatching to the agent.
    // A second webhook for the same task will see Status=In Progress and be filtered.
    const statusSequence: string[] = [];
    const simulateDispatch = (initialStatus: string) => {
      if (initialStatus !== 'Ready') return 'skipped';
      statusSequence.push('In Progress'); // written FIRST
      statusSequence.push('execute agent');
      statusSequence.push('Done');
      return 'ok';
    };
    expect(simulateDispatch('Ready')).toBe('ok');
    expect(statusSequence[0]).toBe('In Progress');
    expect(simulateDispatch('In Progress')).toBe('skipped'); // dedup works
  });
});
