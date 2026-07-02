import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { PageHeader, Section, Tabs } from '../components/ui.js';
import { getStats, type NorcStats } from '../api/stats.js';

// Historical run statistics: who asks, who works, how reliably, how long, and
// (best-effort) how many tokens. All aggregates come from /api/stats, computed
// over the 90-day task_runs retention window.

// Chart colors as literals — SVG fill attributes don't resolve CSS variables.
const C = {
  primary: '#5645d4',
  green: '#1aae39',
  red: '#e03131',
  amber: '#dd5b00',
  dim: '#787671',
  border: '#e5e3df',
  grid: '#f0eeec',
};

const cardStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '16px 20px',
};

function StatCard({ value, label, hint, tone }: { value: string; label: string; hint?: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'var(--accent-green)' : tone === 'bad' ? 'var(--accent-red)' : 'var(--text-primary)';
  return (
    <div style={cardStyle} title={hint}>
      <div style={{ fontSize: 26, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function humanizeMs(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function humanizeTokens(n: number | null): string {
  if (n === null || n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const tooltipStyle: React.CSSProperties = {
  background: '#ffffff', border: `1px solid ${C.border}`, borderRadius: 8,
  fontSize: 12.5, boxShadow: 'var(--shadow-card)',
};

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{children}</div>;
}

type Window = '7' | '30' | '90';

export default function StatisticsPage() {
  const [days, setDays] = useState<Window>('30');
  const [stats, setStats] = useState<NorcStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStats(Number(days)).then(s => { setStats(s); setError(null); })
      .catch(err => setError(err instanceof Error ? err.message : 'failed'));
  }, [days]);

  const doneRuns = stats?.statuses['done'] ?? 0;
  const errorPct = stats?.errorRate === null || stats === null ? '—' : `${(stats.errorRate * 100).toFixed(0)}%`;

  const humansData = (stats?.topHumans ?? []).map(h => ({
    name: h.name ?? `${h.source} user ${h.userId.slice(0, 6)}…`, runs: h.runs,
  }));
  const agentsData = (stats?.topAgents ?? []).map(a => ({ name: a.name, runs: a.runs }));
  const tokensData = (stats?.topAgents ?? []).filter(a => (a.tokens ?? 0) > 0)
    .map(a => ({ name: a.name, tokens: a.tokens ?? 0 }));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <PageHeader title="Statistics" />
        <Tabs
          tabs={[{ id: '7' as Window, label: 'Last 7 days' }, { id: '30' as Window, label: 'Last 30 days' }, { id: '90' as Window, label: 'Last 90 days' }]}
          active={days}
          onChange={setDays}
        />

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--tint-rose)', color: 'var(--accent-red)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <StatCard value={stats ? String(stats.totalRuns) : '—'} label="Finished runs" />
          <StatCard
            value={errorPct}
            label="Error rate"
            hint="failed + timed-out over all finished work runs"
            tone={stats?.errorRate != null ? (stats.errorRate > 0.2 ? 'bad' : 'good') : undefined}
          />
          <StatCard value={humanizeMs(stats?.avgDurationMs ?? null)} label="Avg run duration" />
          <StatCard
            value={humanizeTokens(stats?.tokens.total ?? null)}
            label={`Tokens (${stats?.tokens.runsWithTokens ?? 0} runs reported)`}
            hint="Self-reported by agents via /complete — best-effort, not billing data"
          />
        </div>

        <Section title="Runs per day" description="Completed work runs — done vs failed/timed-out.">
          {stats && stats.perDay.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.perDay} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.dim }} tickLine={false} axisLine={{ stroke: C.border }}
                       tickFormatter={(d: string) => d.slice(5)} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: C.dim }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(86,69,212,0.06)' }} />
                <Bar dataKey="done" name="Done" stackId="runs" fill={C.green} radius={[0, 0, 0, 0]} />
                <Bar dataKey="failed" name="Failed / timed out" stackId="runs" fill={C.red} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyNote>No finished runs in this window yet.</EmptyNote>}
        </Section>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 0, columnGap: 16 }}>
          <Section title="Most active humans" description="Who triggers the most work runs.">
            {humansData.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(120, humansData.length * 34)}>
                <BarChart data={humansData} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
                  <XAxis type="number" allowDecimals={false} hide />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: 'var(--text-secondary)' as unknown as string }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(86,69,212,0.06)' }} />
                  <Bar dataKey="runs" name="Runs" fill={C.primary} radius={[0, 4, 4, 0]} barSize={16}
                       label={{ position: 'right', fontSize: 11, fill: C.dim }} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyNote>No attributed runs yet — Notion/Slack identity lands on each new run.</EmptyNote>}
          </Section>

          <Section title="Hardest-working agents" description="Runs handled per agent.">
            {agentsData.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(120, agentsData.length * 34)}>
                <BarChart data={agentsData} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
                  <XAxis type="number" allowDecimals={false} hide />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: 'var(--text-secondary)' as unknown as string }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(86,69,212,0.06)' }} />
                  <Bar dataKey="runs" name="Runs" fill={C.primary} radius={[0, 4, 4, 0]} barSize={16}
                       label={{ position: 'right', fontSize: 11, fill: C.dim }}>
                    {agentsData.map((_, i) => <Cell key={i} fill={i === 0 ? C.primary : '#8b7fe0'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyNote>No runs in this window yet.</EmptyNote>}
          </Section>
        </div>

        <Section title="Token consumption per agent" description="Self-reported by agents when they call /complete — partial coverage, labeled above.">
          {tokensData.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(120, tokensData.length * 34)}>
              <BarChart data={tokensData} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: 'var(--text-secondary)' as unknown as string }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(86,69,212,0.06)' }}
                         formatter={(v) => [humanizeTokens(typeof v === 'number' ? v : null), 'Tokens']} />
                <Bar dataKey="tokens" name="Tokens" fill={C.amber} radius={[0, 4, 4, 0]} barSize={16}
                     label={{ position: 'right', fontSize: 11, fill: C.dim, formatter: (v) => humanizeTokens(typeof v === 'number' ? v : null) }} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyNote>
              No token reports in this window. Agents send <code>tokensUsed</code> with <code>POST /complete</code> —
              update their NORC skill (v16) so they know to.
            </EmptyNote>
          )}
        </Section>

        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
          Statistics cover work-lane runs only (Slack chat turns excluded) and at most the last 90 days —
          older runs are pruned to keep NORC light on small servers.
        </div>
      </div>
    </div>
  );
}
