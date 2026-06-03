import React, { useEffect, useState } from 'react';

const API = import.meta.env.VITE_NORC_API ?? '';

interface AgentStatus {
  name: string;
  status: 'Available' | 'Busy' | 'Offline';
  lastActive?: string;
  tasksToday: number;
}

export default function Summary() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/agents`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  const statusColor = (s: AgentStatus['status']) =>
    s === 'Available' ? 'var(--accent-green)' :
    s === 'Busy' ? 'var(--accent-amber)' : 'var(--text-dim)';

  const statusLabel = (s: AgentStatus['status']) =>
    `Status: ${s}`;

  // Empty state — first launch
  if (!loading && agents.length === 0) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>◈</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Your agents are ready</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, maxWidth: 360, lineHeight: 1.7 }}>
          Mention <code style={{ background: 'var(--surface2)', padding: '1px 6px', borderRadius: 4 }}>@[Agent Name]</code> anywhere
          in Notion to trigger your first task.
        </div>
        <div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-dim)' }}>
          Register an agent: <code>norc agent add claude-code</code>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <h1 style={{ fontSize: 15, fontWeight: 600, marginBottom: 20 }}>Agent Team</h1>

      {loading && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading agents...</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {agents.map(agent => (
          <div key={agent.name} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{agent.name}</span>
              <span
                style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(agent.status) }}
                title={statusLabel(agent.status)}
                aria-label={statusLabel(agent.status)}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {agent.status} · {agent.tasksToday} tasks today
            </div>
            {agent.lastActive && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                Last: {agent.lastActive}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
