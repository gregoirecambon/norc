export type RunStatus = 'in_flight' | 'done' | 'failed' | 'timed_out';

export interface DashboardRun {
  id: string;
  agentId: string;
  agentName: string;
  title: string | null;
  anchorKind: string;
  pageId: string;
  taskPageId: string | null;
  status: RunStatus;
  agentActed: boolean;
  createdAt: number;
  completedAt: number | null;
}

export interface DashboardData {
  activeRuns: DashboardRun[];
  recentRuns: DashboardRun[];
  stats: { activeRuns: number; agentsConnected: number; agentsTotal: number };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const getDashboard = () => getJson<DashboardData>('/api/dashboard');
