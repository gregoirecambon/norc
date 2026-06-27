// Read-only chores API for the dashboard. The Notion-sync toggle flows through
// the settings API (choresNotionSync); this module just lists what's on disk.

export interface ChoreStepView {
  number: number;
  title: string;
  needs: string;
  do: string;
  returns: string | null;
  after: number[];
}

export interface ChoreSummary {
  id: string;
  description: string;
  trigger: string;
  approval: string;
  minConfidence: number;
  inputs: string[];
  hash: string;
  syncState: string | null;   // 'synced' | 'conflict' | 'disk-only' | null (mirror off)
  steps: ChoreStepView[];
}

export interface ChoresResponse {
  version: number;
  enabled: boolean;
  notionSync: boolean;
  choresDbProvisioned: boolean;
  choresDbUrl: string | null;
  chores: ChoreSummary[];
}

export async function getChores(): Promise<ChoresResponse> {
  const res = await fetch('/api/chores');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<ChoresResponse>;
}

/** Provide the Notion "Chores" DB (renames the dormant Pipeline DB in place when present). */
export async function provisionChoresDb(): Promise<{ created: boolean }> {
  const res = await fetch('/api/notion/provision/chores', { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<{ created: boolean }>;
}
