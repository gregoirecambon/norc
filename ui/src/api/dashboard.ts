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
  /** The session this run addressed (resolveSession). NULL on legacy/just-minted runs. */
  sessionId: string | null;
  /** Deep-link into the agent's own tool, when it's configured with a console URL
   * template. NULL for adapters with no session UI (most). */
  sessionUrl: string | null;
  /** Remote Claude Code only: how to resume this session on the worker machine
   * (SSH there, then `cd <cwd> && claude --resume <sessionId>`). NULL otherwise. */
  resume?: { sshHost: string | null; cwd: string; sessionId: string } | null;
  createdAt: number;
  completedAt: number | null;
}

export interface QueuedItem {
  id: number;
  agentId: string;
  agentName: string;
  title: string | null;
  anchorKind: string;
  pageId: string;
  taskPageId: string | null;
  projectId: string | null;
  priority: number;
  enqueuedAt: number;
}

export interface DashboardData {
  activeRuns: DashboardRun[];
  recentRuns: DashboardRun[];
  queued: QueuedItem[];
  stats: { activeRuns: number; queuedItems: number; agentsConnected: number; agentsTotal: number };
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
