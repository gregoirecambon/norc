export interface AgentRow {
  id: string;
  name: string;
  adapterType: 'openclaw' | 'claude-api' | 'http';
  adapterConfig: Record<string, unknown>;
  status: 'connected' | 'unreachable' | 'untested';
  lastPingedAt: number | null;
  lastLatencyMs: number | null;
  registeredAt: number;
  metadata: Record<string, unknown>;
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

export async function initiateWsPairing(id: string): Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string; deviceId?: string }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/ws-pair`, { method: 'POST' });
  return res.json() as Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string; deviceId?: string }>;
}

export async function verifyWsPairing(id: string): Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string }> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/ws-pair/verify`, { method: 'POST' });
  return res.json() as Promise<{ status: 'paired' | 'pending' | 'failed'; error?: string }>;
}

export async function deleteAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
