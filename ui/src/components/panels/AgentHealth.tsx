import { useState, useEffect } from 'react';
import { listAgents, type AgentRow } from '../../api/agents.js';
import { StatusBadge } from '../StatusBadge.js';
import { parseSse } from '../../lib/sse.js';

function ago(ms: number | null): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** Live agent roster with health (status, last ping, latency). Updates from SSE. */
export function AgentHealth() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listAgents().then(setAgents).catch(() => setAgents([])).finally(() => setLoaded(true));
    const es = new EventSource('/api/events/stream');
    es.addEventListener('agent.updated', (e: MessageEvent) => {
      const d = parseSse<{ id: string; status?: AgentRow['status']; lastPingedAt?: number | null; lastLatencyMs?: number | null }>(e.data);
      if (!d) return;
      setAgents(prev => prev.map(a => a.id !== d.id ? a : {
        ...a,
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.lastPingedAt !== undefined ? { lastPingedAt: d.lastPingedAt } : {}),
        ...(d.lastLatencyMs !== undefined ? { lastLatencyMs: d.lastLatencyMs } : {}),
      }));
    });
    es.addEventListener('agent.registered', (e: MessageEvent) => {
      const a = parseSse<AgentRow>(e.data);
      if (!a) return;
      setAgents(prev => prev.some(x => x.id === a.id) ? prev : [...prev, a]);
    });
    es.addEventListener('agent.deleted', (e: MessageEvent) => {
      const parsed = parseSse<{ id: string }>(e.data);
      if (!parsed) return;
      setAgents(prev => prev.filter(a => a.id !== parsed.id));
    });
    return () => es.close();
  }, []);

  if (loaded && agents.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No agents registered yet.</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
      {agents.map(a => (
        <div key={a.id} style={{
          background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            <StatusBadge status={a.status} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.adapterType}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            pinged {ago(a.lastPingedAt)}{a.lastLatencyMs != null ? ` · ${a.lastLatencyMs}ms` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
