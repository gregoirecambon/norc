import { useEffect, useState } from 'react';
import { listAgents, type AgentRow } from '../api/agents.js';
import { InvitePanel } from '../components/InvitePanel.js';
import { AgentTable } from '../components/AgentTable.js';
import { PlatformsPanel } from '../components/PlatformsPanel.js';
import { LogStream } from '../components/LogStream.js';

export default function Agents() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, []);

  // Real-time events via SSE
  useEffect(() => {
    const es = new EventSource('/api/events/stream');

    es.addEventListener('agent.registered', (e: MessageEvent) => {
      const agent = JSON.parse(e.data as string) as AgentRow;
      setAgents(prev => {
        if (prev.some(a => a.id === agent.id)) return prev;
        return [...prev, agent];
      });
    });

    es.addEventListener('agent.deleted', (e: MessageEvent) => {
      const { id } = JSON.parse(e.data as string) as { id: string };
      setAgents(prev => prev.filter(a => a.id !== id));
    });

    es.addEventListener('agent.updated', (e: MessageEvent) => {
      const { id, adapterConfig } = JSON.parse(e.data as string) as { id: string; adapterConfig: Record<string, unknown> };
      setAgents(prev => prev.map(a => a.id === id ? { ...a, adapterConfig } : a));
    });

    es.addEventListener('handshake.updated', (e: MessageEvent) => {
      const { agentId, status, latencyMs } = JSON.parse(e.data as string) as {
        agentId: string; status: string; latencyMs: number | null; handshakeId: string; error: string | null;
      };
      if (status === 'completed') {
        setAgents(prev => prev.map(a =>
          a.id === agentId
            ? { ...a, status: 'connected', lastPingedAt: Date.now(), lastLatencyMs: latencyMs }
            : a
        ));
      }
    });

    return () => es.close();
  }, []);

  const handlePingResult = (id: string, status: 'connected' | 'unreachable', latencyMs: number) => {
    setAgents(prev => prev.map(a =>
      a.id === id ? { ...a, status, lastPingedAt: Date.now(), lastLatencyMs: latencyMs } : a
    ));
  };

  const handleDeleted = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id));
  };

  const handleConfigUpdated = (id: string, adapterConfig: Record<string, unknown>) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, adapterConfig } : a));
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, maxWidth: 960, width: '100%' }}>
      <InvitePanel hasAgents={agents.length > 0} />

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14, gap: 10 }}>
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Registered Agents</h1>
        {!loading && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 8px' }}>
            {agents.length}
          </span>
        )}
      </div>

      <AgentTable
        agents={agents}
        loading={loading}
        onPingResult={handlePingResult}
        onDeleted={handleDeleted}
        onConfigUpdated={handleConfigUpdated}
      />

      <div style={{ marginTop: 24 }}>
        <PlatformsPanel agents={agents} />
      </div>

      <LogStream />
    </div>
  );
}
