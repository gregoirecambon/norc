export type AdapterType = 'openclaw' | 'claude-api' | 'http';
export type AgentStatus = 'connected' | 'unreachable' | 'untested';

export interface Agent {
  id: string;
  name: string;
  adapterType: AdapterType;
  adapterConfig: Record<string, unknown>;
  status: AgentStatus;
  lastPingedAt: number | null;
  lastLatencyMs: number | null;
  registeredAt: number;
  metadata: Record<string, unknown>;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  detail?: string;
}

export interface RegistrationToken {
  id: string;
  token: string;
  createdAt: number;
  usedAt: number | null;
  usedByAgent: string | null;
}
