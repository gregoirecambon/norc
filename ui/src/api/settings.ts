export type TriageProvider = 'anthropic' | 'openai';

export interface NorcSettings {
  orchestratorEnabled: boolean;
  orchestratorProvider: TriageProvider;
  orchestratorApiKeySet: boolean;
  orchestratorBaseUrl: string | null;
  orchestratorModel: string;
  orchestratorSystemPrompt: string | null;
  autoRouteThreshold: number;
  runTimeoutSec: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number;
  schedulerEnabled: boolean;
  autoProposeEnabled: boolean;
  autoProposeIntervalHours: number;
  updatedAt: number;
}

export interface NorcSettingsPatch {
  orchestratorEnabled?: boolean;
  orchestratorProvider?: TriageProvider;
  orchestratorApiKey?: string | null;
  orchestratorBaseUrl?: string | null;
  orchestratorModel?: string;
  orchestratorSystemPrompt?: string | null;
  autoRouteThreshold?: number;
  runTimeoutSec?: number;
  heartbeatEnabled?: boolean;
  heartbeatIntervalSec?: number;
  schedulerEnabled?: boolean;
  autoProposeEnabled?: boolean;
  autoProposeIntervalHours?: number;
}

export async function getSettings(): Promise<NorcSettings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<NorcSettings>;
}

export async function saveSettings(patch: NorcSettingsPatch): Promise<NorcSettings> {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<NorcSettings>;
}

export interface TriageTestRequest {
  provider?: TriageProvider;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
}

export interface TriageTestResult {
  ok: boolean;
  latencyMs?: number;
  sample?: string;
  error?: string;
}

export async function testTriageConnection(req: TriageTestRequest): Promise<TriageTestResult> {
  const res = await fetch('/api/settings/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return res.json() as Promise<TriageTestResult>;
}
