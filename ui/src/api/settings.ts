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
  runHardCapSec: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalSec: number;
  deepPingEnabled: boolean;
  deepPingIntervalSec: number;
  failureNotifyThreshold: number;
  schedulerEnabled: boolean;
  autoProposeEnabled: boolean;
  autoProposeIntervalHours: number;
  choresEnabled: boolean;
  choresNotionSync: boolean;
  feedbackEnabled: boolean;
  feedbackSampleRate: number;
  feedbackChannel: 'slack' | 'email';
  feedbackFormRequiresLogin: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpUser: string | null;
  smtpPassSet: boolean;
  smtpFrom: string | null;
  smtpSecure: boolean;
  smtpSource: 'settings' | 'env' | null;
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
  runHardCapSec?: number;
  heartbeatEnabled?: boolean;
  heartbeatIntervalSec?: number;
  deepPingEnabled?: boolean;
  deepPingIntervalSec?: number;
  failureNotifyThreshold?: number;
  schedulerEnabled?: boolean;
  autoProposeEnabled?: boolean;
  autoProposeIntervalHours?: number;
  choresEnabled?: boolean;
  choresNotionSync?: boolean;
  feedbackEnabled?: boolean;
  feedbackSampleRate?: number;
  feedbackChannel?: 'slack' | 'email';
  feedbackFormRequiresLogin?: boolean;
  smtpHost?: string | null;
  smtpPort?: number;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpFrom?: string | null;
  smtpSecure?: boolean;
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

export interface TestEmailRequest {
  host?: string;
  port?: number;
  user?: string | null;
  pass?: string;
  from?: string | null;
  secure?: boolean;
}

export interface TestEmailResult {
  ok: boolean;
  latencyMs?: number;
  to?: string;
  error?: string;
}

export async function sendTestEmail(req: TestEmailRequest): Promise<TestEmailResult> {
  const res = await fetch('/api/settings/test-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return res.json() as Promise<TestEmailResult>;
}
