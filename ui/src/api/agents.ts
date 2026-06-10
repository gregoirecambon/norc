export type AdapterType = 'openclaw' | 'claude-api' | 'http' | 'claude-local' | 'codex-local';

export interface AgentRow {
  id: string;
  name: string;
  adapterType: AdapterType;
  adapterConfig: Record<string, unknown>;
  status: 'connected' | 'unreachable' | 'untested';
  lastPingedAt: number | null;
  lastLatencyMs: number | null;
  registeredAt: number;
  metadata: Record<string, unknown>;
  orgDbPageId: string | null;
  maxConcurrentRuns: number;
  slackEnabled: boolean;
  slackHandle: string | null;
}

export interface InviteData {
  token: string;
  norcUrl: string;
  prompt: string;
}

export interface PingResponse {
  ok: boolean;
  latencyMs: number;
  agentId: string;
  testedAt: number;
  error?: string;
}

export async function listAgents(): Promise<AgentRow[]> {
  const res = await fetch('/api/agents');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<AgentRow[]>;
}

export async function getInvite(): Promise<InviteData> {
  const res = await fetch('/api/agents/invite');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<InviteData>;
}

export async function pingAgent(id: string): Promise<PingResponse> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/ping`, { method: 'POST' });
  const body = await res.json() as PingResponse;
  return body;
}

export async function updateAgentConfig(id: string, config: Record<string, unknown>): Promise<{ adapterConfig: Record<string, unknown> }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<{ adapterConfig: Record<string, unknown> }>;
}

export async function createAgent(payload: {
  name: string;
  adapterType: AdapterType;
  adapterConfig: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<AgentRow> {
  const res = await fetch('/api/agents/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata: {}, ...payload }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<AgentRow>;
}

export async function initiateWsPairing(id: string): Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string; deviceId?: string }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/ws-pair`, { method: 'POST' });
  return res.json() as Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string; deviceId?: string }>;
}

export async function verifyWsPairing(id: string): Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/ws-pair/verify`, { method: 'POST' });
  return res.json() as Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string }>;
}

export async function syncAgentToNotion(id: string): Promise<{ orgDbPageId: string; url: string | null }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/sync-notion`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<{ orgDbPageId: string; url: string | null }>;
}

export interface SkillUpdateResponse {
  pushed: boolean;
  reason?: string;
  version: number;
  skillUrl: string;
}

export async function updateAgentSkills(id: string): Promise<SkillUpdateResponse> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/update-skills`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<SkillUpdateResponse>;
}

export async function updateAgentLimits(id: string, maxConcurrentRuns: number): Promise<{ maxConcurrentRuns: number }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/limits`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrentRuns }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<{ maxConcurrentRuns: number }>;
}

export async function toggleAgentSlack(id: string, enabled: boolean): Promise<{ enabled: boolean; handle: string | null; warning?: string }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/slack`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<{ enabled: boolean; handle: string | null; warning?: string }>;
}

export async function deleteAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
