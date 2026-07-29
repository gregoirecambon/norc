// Apps — non-AI API clients (n8n, custom services…) holding a static key to
// the /api/ext machine surface. Managed from the dashboard; the key is
// returned exactly once, on create and on rotate.

export type AppScope = 'read' | 'tasks:write' | 'tasks:approve';

export interface AppRow {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  scopes: AppScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  orgDbPageId: string | null;
}

export interface AppAccessRow {
  method: string;
  path: string;
  status: number;
  ip: string | null;
  at: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listApps(): Promise<AppRow[]> {
  return json(await fetch('/api/apps'));
}

export async function createApp(input: { name: string; description?: string; scopes: AppScope[] }): Promise<AppRow & { key: string }> {
  return json(await fetch('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

export async function rotateAppKey(id: string): Promise<AppRow & { key: string }> {
  return json(await fetch(`/api/apps/${id}/rotate`, { method: 'POST' }));
}

export async function revokeApp(id: string): Promise<AppRow> {
  return json(await fetch(`/api/apps/${id}/revoke`, { method: 'POST' }));
}

export async function deleteApp(id: string): Promise<{ ok: boolean }> {
  return json(await fetch(`/api/apps/${id}`, { method: 'DELETE' }));
}

export async function syncAppToNotion(id: string): Promise<{ orgDbPageId: string; url: string | null }> {
  return json(await fetch(`/api/apps/${id}/sync-notion`, { method: 'POST' }));
}

export async function appAccessLog(id: string): Promise<AppAccessRow[]> {
  return json(await fetch(`/api/apps/${id}/access`));
}
