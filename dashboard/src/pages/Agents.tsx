import React, { useEffect, useState } from 'react';

const API = import.meta.env.VITE_NORC_API ?? 'http://localhost:3001';

interface Agent {
  name: string;
  adapter: string;
  contextLevel: string;
  timeoutMin: number;
  status: string;
  lastActive: string | null;
}

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/agents`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  if (!loading && agents.length === 0) {
    return (
      <div style={{ padding: 40, color: 'var(--text-secondary)', fontSize: 13 }}>
        No agents registered. Run <code style={{ background: 'var(--surface2)', padding: '1px 5px', borderRadius: 4 }}>norc agent add &lt;name&gt;</code> to add one.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <h1 style={{ fontSize: 15, fontWeight: 600, marginBottom: 20 }}>Registered Agents</h1>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            <th style={{ padding: '6px 12px', textAlign: 'left' }}>Name</th>
            <th style={{ padding: '6px 12px', textAlign: 'left' }}>Adapter</th>
            <th style={{ padding: '6px 12px', textAlign: 'left' }}>Context</th>
            <th style={{ padding: '6px 12px', textAlign: 'left' }}>Status</th>
            <th style={{ padding: '6px 12px', textAlign: 'left' }}>Last Active</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(a => (
            <tr key={a.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <td style={{ padding: '8px 12px', fontWeight: 500 }}>{a.name}</td>
              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{a.adapter}</td>
              <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{a.contextLevel}</td>
              <td style={{ padding: '8px 12px' }}>
                <span style={{ color: a.status === 'Available' ? 'var(--accent-green)' : a.status === 'Busy' ? 'var(--accent-amber)' : 'var(--text-dim)' }}>
                  ● <span>{a.status}</span>
                </span>
              </td>
              <td style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>{a.lastActive ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
