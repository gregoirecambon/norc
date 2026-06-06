export type NotionStatus = 'pending_key' | 'pending_webhook' | 'active';
export type WorkspaceStatus = 'not_provisioned' | 'provisioned';

export interface NotionIntegration {
  id: string;
  status: NotionStatus;
  workspaceName: string | null;
  botName: string | null;
  webhookVerifyToken: string | null;
  webhookVerifiedAt: number | null;
  webhookUrl: string;
  parentPageId: string | null;
  workspaceStatus: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface NotionDatabase {
  kind: string;
  notionDatabaseId: string;
  title: string;
  url: string | null;
}

export interface NotionConfig {
  integration: NotionIntegration | null;
  webhookUrl: string;
  databases: NotionDatabase[];
}

export async function getNotionConfig(): Promise<NotionConfig> {
  const res = await fetch('/api/notion');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<NotionConfig>;
}

export async function provisionWorkspace(parentPage: string): Promise<NotionDatabase[]> {
  const res = await fetch('/api/notion/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPage }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  const body = await res.json() as { databases: NotionDatabase[] };
  return body.databases;
}

export async function provisionCompanyDb(): Promise<{ created: boolean; database: NotionDatabase }> {
  const res = await fetch('/api/notion/provision/company', { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<{ created: boolean; database: NotionDatabase }>;
}

export async function saveNotionKey(apiKey: string): Promise<NotionIntegration> {
  const res = await fetch('/api/notion/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<NotionIntegration>;
}

export async function deleteNotionIntegration(): Promise<void> {
  const res = await fetch('/api/notion', { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}`);
}
