export interface SlackIntegration {
  id: string | null;
  status: string;                       // 'pending' | 'active' | 'error'
  teamName: string | null;
  botName: string | null;
  botUserId: string | null;
  appId: string | null;
  botTokenSet: boolean;
  signingSecretSet: boolean;
  source: 'settings' | 'env' | null;
  webhookUrl: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface SlackInfo {
  integration: SlackIntegration;
  webhookUrl: string;
  manifest: Record<string, unknown>;
}

export interface SlackTestResult {
  ok: boolean;
  teamName?: string;
  botName?: string;
  error?: string;
  latencyMs: number;
}

export async function getSlack(): Promise<SlackInfo> {
  const res = await fetch('/api/slack');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<SlackInfo>;
}

export async function saveSlackConfig(patch: { botToken?: string; signingSecret?: string }): Promise<SlackIntegration> {
  const res = await fetch('/api/slack/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `${res.status}`);
  }
  return res.json() as Promise<SlackIntegration>;
}

export async function testSlack(): Promise<SlackTestResult> {
  const res = await fetch('/api/slack/test', { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<SlackTestResult>;
}

export async function disconnectSlack(): Promise<void> {
  const res = await fetch('/api/slack', { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}`);
}
