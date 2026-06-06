export type TriageProvider = 'anthropic' | 'openai';

export interface NorcSettings {
  orchestratorEnabled: boolean;
  orchestratorProvider: TriageProvider;
  orchestratorApiKeySet: boolean;
  orchestratorBaseUrl: string | null;
  orchestratorModel: string;
  orchestratorSystemPrompt: string | null;
  autoRouteThreshold: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number;
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
  heartbeatEnabled?: boolean;
  heartbeatIntervalSec?: number;
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
