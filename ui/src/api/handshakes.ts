export interface HandshakeStarted {
  handshakeId: string;
  status: 'pending';
  agentId: string;
  createdAt: number;
}

export interface HandshakeStatus {
  handshakeId: string;
  agentId: string;
  status: 'pending' | 'completed' | 'timed_out';
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

export async function startHandshake(agentId: string): Promise<HandshakeStarted> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/handshake`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<HandshakeStarted>;
}

export async function getHandshakeStatus(agentId: string, handshakeId: string): Promise<HandshakeStatus> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/handshake/${encodeURIComponent(handshakeId)}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<HandshakeStatus>;
}
