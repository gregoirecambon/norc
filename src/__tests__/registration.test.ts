import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Agent name slug validation (pure logic, no I/O)
// ---------------------------------------------------------------------------
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function validateAgentName(name: string): { ok: boolean; error?: string } {
  if (!name) return { ok: false, error: 'missing_name' };
  if (!AGENT_NAME_RE.test(name)) return { ok: false, error: 'invalid_name' };
  return { ok: true };
}

describe('agent name slug validation', () => {
  it('accepts valid slugs', () => {
    expect(validateAgentName('my-agent').ok).toBe(true);
    expect(validateAgentName('claude-code').ok).toBe(true);
    expect(validateAgentName('a').ok).toBe(true);
    expect(validateAgentName('agent123').ok).toBe(true);
    expect(validateAgentName('my_bot').ok).toBe(true);
  });

  it('rejects empty name', () => {
    expect(validateAgentName('').ok).toBe(false);
    expect(validateAgentName('').error).toBe('missing_name');
  });

  it('rejects names with spaces', () => {
    expect(validateAgentName('my agent').ok).toBe(false);
    expect(validateAgentName("greg's bot").ok).toBe(false);
  });

  it('rejects names with slashes', () => {
    expect(validateAgentName('team/alpha').ok).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(validateAgentName('MyAgent').ok).toBe(false);
  });

  it('rejects name starting with hyphen', () => {
    expect(validateAgentName('-agent').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NORC_REGISTRATION_TOKEN validation
// ---------------------------------------------------------------------------
function isValidToken(t: string | undefined): boolean {
  return typeof t === 'string' && t.length >= 32;
}

describe('registration token validation', () => {
  it('accepts token >= 32 chars', () => {
    expect(isValidToken('a'.repeat(32))).toBe(true);
    expect(isValidToken('a'.repeat(64))).toBe(true);
  });

  it('rejects short tokens', () => {
    expect(isValidToken('short')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });

  it('rejects empty string (common .env mistake)', () => {
    expect(isValidToken('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidToken(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findAgentByName: exact match takes priority over substring
// ---------------------------------------------------------------------------
interface AgentRecord { name: string; id: string }

function findAgentByName(agents: AgentRecord[], name: string): AgentRecord | null {
  const lower = name.toLowerCase();
  return agents.find(a => a.name.toLowerCase() === lower)
    ?? agents.find(a => a.name.toLowerCase().includes(lower))
    ?? null;
}

describe('findAgentByName exact-match priority', () => {
  const agents: AgentRecord[] = [
    { name: 'claude-code', id: '1' },
    { name: 'code-review', id: '2' },
    { name: 'code', id: '3' },
  ];

  it('returns exact match when it exists', () => {
    expect(findAgentByName(agents, 'code')?.id).toBe('3');
    expect(findAgentByName(agents, 'claude-code')?.id).toBe('1');
    expect(findAgentByName(agents, 'code-review')?.id).toBe('2');
  });

  it('falls back to substring when no exact match', () => {
    const agents2: AgentRecord[] = [
      { name: 'claude-code', id: '1' },
      { name: 'code-review', id: '2' },
    ];
    // 'code' has no exact match — substring returns first match
    expect(findAgentByName(agents2, 'code')?.id).toBe('1');
  });

  it('returns null when no match at all', () => {
    expect(findAgentByName(agents, 'nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NORC_OUTPUT sentinel parsing
// ---------------------------------------------------------------------------
interface NorcOutput { status: string; summary: string; next_agent: string | null }

function parseNorcOutput(stdout: string): { nextAgent?: string; summary?: string } {
  const lines = stdout.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('NORC_OUTPUT:')) {
      try {
        const json: NorcOutput = JSON.parse(line.slice('NORC_OUTPUT:'.length).trim());
        return {
          nextAgent: json.next_agent ?? undefined,
          summary: json.summary ?? undefined,
        };
      } catch {
        return {};
      }
    }
  }
  return {};
}

describe('NORC_OUTPUT sentinel parsing', () => {
  it('parses sentinel from last line', () => {
    const stdout = 'Here is my analysis.\n\nNORC_OUTPUT: {"status":"done","summary":"Fixed the bug","next_agent":null}';
    const result = parseNorcOutput(stdout);
    expect(result.summary).toBe('Fixed the bug');
    expect(result.nextAgent).toBeUndefined();
  });

  it('parses next_agent when set', () => {
    const stdout = 'Analysis complete.\nNORC_OUTPUT: {"status":"done","summary":"Delegating","next_agent":"code-review"}';
    const result = parseNorcOutput(stdout);
    expect(result.nextAgent).toBe('code-review');
  });

  it('returns empty when no sentinel', () => {
    const stdout = 'Just some output with no sentinel.';
    expect(parseNorcOutput(stdout)).toEqual({});
  });

  it('ignores non-final NORC_OUTPUT lines', () => {
    const stdout = 'NORC_OUTPUT: {"status":"done","summary":"old","next_agent":"wrong"}\nActual output\nNORC_OUTPUT: {"status":"done","summary":"correct","next_agent":"right"}';
    const result = parseNorcOutput(stdout);
    expect(result.summary).toBe('correct');
    expect(result.nextAgent).toBe('right');
  });

  it('handles malformed JSON gracefully', () => {
    const stdout = 'NORC_OUTPUT: {bad json}';
    expect(parseNorcOutput(stdout)).toEqual({});
  });

  it('handles multiple JSON blocks in output without false matches', () => {
    const stdout = '{"key":"value"}\n{"other":"block"}\nNORC_OUTPUT: {"status":"done","summary":"real","next_agent":null}';
    const result = parseNorcOutput(stdout);
    expect(result.summary).toBe('real');
  });
});

// ---------------------------------------------------------------------------
// Lineage: child routing preference
// ---------------------------------------------------------------------------
interface AgentEntry { name: string; parentAgent?: string }

function resolveNextAgent(agents: AgentEntry[], currentAgent: string, requestedNext: string): string | null {
  if (!requestedNext) return null;
  // Prefer children of current agent
  const children = agents.filter(a => a.parentAgent === currentAgent);
  const childMatch = children.find(a => a.name === requestedNext);
  if (childMatch) return childMatch.name;
  // Fall back to exact name match across all agents
  const exact = agents.find(a => a.name === requestedNext);
  return exact?.name ?? null;
}

describe('lineage child routing preference (schema-only, no behavior change)', () => {
  const agents: AgentEntry[] = [
    { name: 'orchestrator' },
    { name: 'claude-code', parentAgent: 'orchestrator' },
    { name: 'code-review', parentAgent: 'orchestrator' },
    { name: 'independent-agent' },
  ];

  it('routes to child agent when requested agent is a child', () => {
    expect(resolveNextAgent(agents, 'orchestrator', 'claude-code')).toBe('claude-code');
  });

  it('falls back to any exact match when not a child', () => {
    expect(resolveNextAgent(agents, 'claude-code', 'independent-agent')).toBe('independent-agent');
  });

  it('returns null when agent not found', () => {
    expect(resolveNextAgent(agents, 'orchestrator', 'nonexistent')).toBeNull();
  });
});
