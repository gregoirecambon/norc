export interface StatsAgent {
  agentId: string;
  name: string;
  runs: number;
  avgDurationMs: number | null;
  tokens: number | null;
}

export interface StatsHuman {
  userId: string;
  name: string | null;
  runs: number;
  source: 'notion' | 'slack';
}

export interface StatsDay {
  day: string;
  done: number;
  failed: number;
}

export interface NorcStats {
  days: number;
  totalRuns: number;
  errorRate: number | null;
  avgDurationMs: number | null;
  statuses: Record<string, number>;
  perDay: StatsDay[];
  topAgents: StatsAgent[];
  topHumans: StatsHuman[];
  tokens: { total: number | null; runsWithTokens: number };
}

export async function getStats(days: number): Promise<NorcStats> {
  const res = await fetch(`/api/stats?days=${days}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<NorcStats>;
}
