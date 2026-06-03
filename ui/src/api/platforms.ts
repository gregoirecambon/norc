export interface Platform {
  id: string;
  name: string;
  description: string | null;
  hasApiKey: boolean;
  createdAt: number;
  grantedAgentIds: string[];
}

export async function listPlatforms(): Promise<Platform[]> {
  const res = await fetch('/api/platforms');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<Platform[]>;
}

export async function createPlatform(data: { name: string; description?: string; apiKey: string }): Promise<Platform> {
  const res = await fetch('/api/platforms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json() as { message?: string; error?: string };
    throw new Error(err.message ?? err.error ?? `${res.status}`);
  }
  return res.json() as Promise<Platform>;
}

export async function deletePlatform(id: string): Promise<void> {
  await fetch(`/api/platforms/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function grantPlatformAccess(platformId: string, agentId: string): Promise<void> {
  await fetch(`/api/platforms/${encodeURIComponent(platformId)}/grant/${encodeURIComponent(agentId)}`, { method: 'POST' });
}

export async function revokePlatformAccess(platformId: string, agentId: string): Promise<void> {
  await fetch(`/api/platforms/${encodeURIComponent(platformId)}/grant/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}
