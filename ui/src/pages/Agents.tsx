import { useEffect, useState } from 'react';
import { listAgents, syncAgentToNotion, type AgentRow } from '../api/agents.js';
import { getNotionConfig, listOrgMembers, type OrgMemberRow } from '../api/notion.js';
import { AgentTable } from '../components/AgentTable.js';
import { AddAgentModal } from '../components/AddAgentModal.js';
import { parseSse } from '../lib/sse.js';
import { timeAgo } from '../lib/time.js';

const STATUS_STYLE: Record<AgentRow['status'], { bg: string; text: string; label: string }> = {
  connected:  { bg: 'var(--tint-mint)',    text: 'var(--tint-mint-text)',    label: 'Connected' },
  unreachable:{ bg: '#fde8e8',             text: 'var(--accent-red)',        label: 'Unreachable' },
  untested:   { bg: 'var(--surface1)',     text: 'var(--text-dim)',          label: 'Untested' },
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [provisioned, setProvisioned] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [orgMembers, setOrgMembers] = useState<OrgMemberRow[]>([]);

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
    getNotionConfig()
      .then(cfg => setProvisioned(cfg.integration?.workspaceStatus === 'provisioned'))
      .catch(() => setProvisioned(false));
    listOrgMembers()
      .then(setOrgMembers)
      .catch(() => setOrgMembers([]));
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');

    es.addEventListener('agent.registered', (e: MessageEvent) => {
      const agent = parseSse<AgentRow>(e.data);
      if (!agent) return;
      setAgents(prev => prev.some(a => a.id === agent.id) ? prev : [...prev, agent]);
    });

    es.addEventListener('agent.deleted', (e: MessageEvent) => {
      const parsed = parseSse<{ id: string }>(e.data);
      if (!parsed) return;
      setAgents(prev => prev.filter(a => a.id !== parsed.id));
    });

    es.addEventListener('agent.updated', (e: MessageEvent) => {
      const data = parseSse<{
        id: string; adapterConfig?: Record<string, unknown>; orgDbPageId?: string | null;
        status?: AgentRow['status']; lastPingedAt?: number | null; lastLatencyMs?: number | null;
      }>(e.data);
      if (!data) return;
      setAgents(prev => prev.map(a => {
        if (a.id !== data.id) return a;
        const next = { ...a };
        if (data.adapterConfig !== undefined) next.adapterConfig = data.adapterConfig;
        if (data.orgDbPageId !== undefined) next.orgDbPageId = data.orgDbPageId;
        if (data.status !== undefined) next.status = data.status;
        if (data.lastPingedAt !== undefined) next.lastPingedAt = data.lastPingedAt;
        if (data.lastLatencyMs !== undefined) next.lastLatencyMs = data.lastLatencyMs;
        return next;
      }));
    });

    es.addEventListener('notion.workspace.updated', (e: MessageEvent) => {
      const parsed = parseSse<{ workspaceStatus: string }>(e.data);
      if (!parsed) return;
      setProvisioned(parsed.workspaceStatus === 'provisioned');
    });

    es.addEventListener('handshake.updated', (e: MessageEvent) => {
      const parsed = parseSse<{ agentId: string; status: string; latencyMs: number | null }>(e.data);
      if (!parsed) return;
      const { agentId, status, latencyMs } = parsed;
      if (status === 'completed') {
        setAgents(prev => prev.map(a =>
          a.id === agentId ? { ...a, status: 'connected', lastPingedAt: Date.now(), lastLatencyMs: latencyMs } : a
        ));
      }
    });

    return () => es.close();
  }, []);

  const handlePingResult = (id: string, status: 'connected' | 'unreachable', latencyMs: number) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, status, lastPingedAt: Date.now(), lastLatencyMs: latencyMs } : a));
  };

  const handleDeleted = (id: string) => setAgents(prev => prev.filter(a => a.id !== id));

  const handleConfigUpdated = (id: string, adapterConfig: Record<string, unknown>) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, adapterConfig } : a));
  };

  const handleAgentCreated = (agent: AgentRow) => {
    setAgents(prev => prev.some(a => a.id === agent.id) ? prev : [...prev, agent]);
  };

  const handleSynced = (id: string, orgDbPageId: string) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, orgDbPageId } : a));
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    setSyncMsg('');
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const a of agents) {
        try {
          const { orgDbPageId } = await syncAgentToNotion(a.id);
          handleSynced(a.id, orgDbPageId);
          ok++;
        } catch (e) {
          failures.push(`${a.name}: ${e instanceof Error ? e.message : 'failed'}`);
        }
      }
      setSyncMsg(
        failures.length === 0
          ? `Synced ${ok} agent${ok === 1 ? '' : 's'} to Notion.`
          : `Synced ${ok}; ${failures.length} failed — ${failures.join('; ')}`,
      );
    } finally {
      setSyncingAll(false);
    }
  };

  // Empty state
  if (!loading && agents.length === 0) {
    return (
      <>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 'var(--radius-lg)',
            background: 'var(--tint-lavender)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20,
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="8" r="4" stroke="var(--primary)" strokeWidth="2"/>
              <path d="M4 20c0-4.418 3.582-8 8-8s8 3.582 8 8" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>No agents yet</div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', maxWidth: 340, lineHeight: 1.6, marginBottom: 24 }}>
            Add your first agent — generate an invite prompt for Claude Code or Codex, or set one up manually.
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              padding: '10px 22px', borderRadius: 'var(--radius-md)',
              border: 'none', background: 'var(--primary)',
              color: 'var(--on-primary)', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Add Agent
          </button>
        </div>
        {showAddModal && (
          <AddAgentModal
            onClose={() => setShowAddModal(false)}
            onCreated={handleAgentCreated}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: 0 }}>
            AI Agents
          </h1>
          {!loading && (
            <span style={{
              padding: '2px 9px', borderRadius: 4,
              background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)',
              fontSize: 12, fontWeight: 600,
            }}>
              {agents.length}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={handleSyncAll}
            disabled={!provisioned || syncingAll || agents.length === 0}
            title={provisioned ? 'Create/update an Org DB page for every agent' : 'Provision the Notion workspace first (Notion → Workspace)'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)', background: 'var(--surface1)',
              color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500,
              cursor: (!provisioned || syncingAll || agents.length === 0) ? 'default' : 'pointer',
              opacity: (!provisioned || agents.length === 0) ? 0.5 : 1,
            }}
          >
            {syncingAll ? 'Syncing…' : 'Sync all to Notion'}
          </button>
          {syncMsg && (
            <span style={{ fontSize: 12, color: syncMsg.includes('failed') ? 'var(--accent-red, #d33)' : 'var(--text-secondary)', maxWidth: 360 }}>
              {syncMsg}
            </span>
          )}
          <button
            onClick={() => setShowAddModal(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 'var(--radius-md)',
              border: 'none', background: 'var(--primary)',
              color: 'var(--on-primary)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Add Agent
          </button>
        </div>

        {/* Status cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 12, marginBottom: 32 }}>
          {loading
            ? Array.from({ length: 3 }, (_, i) => (
                <div key={i} style={cardStyle}>
                  <div style={{ height: 14, background: 'var(--surface1)', borderRadius: 4, width: '65%', marginBottom: 10 }} />
                  <div style={{ height: 10, background: 'var(--surface1)', borderRadius: 4, width: '40%' }} />
                </div>
              ))
            : agents.map(a => {
                const s = STATUS_STYLE[a.status];
                return (
                  <div key={a.id} style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.3 }}>{a.name}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 4, background: s.bg, color: s.text, fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                        {s.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 2 }}>{a.adapterType}</div>
                    {a.lastPingedAt && (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{timeAgo(a.lastPingedAt)}</div>
                    )}
                    {a.lastLatencyMs != null && (
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                        {a.lastLatencyMs}ms
                      </div>
                    )}
                  </div>
                );
              })
          }
        </div>

        {/* Registry table */}
        {!loading && agents.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 10 }}>
              Registry
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              <AgentTable
                agents={agents}
                loading={false}
                provisioned={provisioned}
                onPingResult={handlePingResult}
                onDeleted={handleDeleted}
                onConfigUpdated={handleConfigUpdated}
                onSynced={handleSynced}
              />
            </div>
          </>
        )}

        {/* Org roster — NORC itself + the human team from the Notion Org DB (read-only) */}
        {orgMembers.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px', margin: '32px 0 10px' }}>
              Org roster
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 12 }}>
              {orgMembers.map(m => (
                <div key={m.pageId} style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                      {m.type === 'orchestrator' ? '🧭 ' : ''}{m.name || '(unnamed)'}
                    </span>
                    <span style={{
                      padding: '2px 8px', borderRadius: 4,
                      background: m.type === 'orchestrator' ? 'var(--tint-lavender)' : 'var(--surface1)',
                      color: m.type === 'orchestrator' ? 'var(--tint-lavender-text)' : 'var(--text-dim)',
                      fontSize: 11, fontWeight: 600, flexShrink: 0,
                    }}>
                      {m.type === 'orchestrator' ? 'Orchestrator' : 'Human'}
                    </span>
                  </div>
                  {m.specialty && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 2 }}>{m.specialty}</div>}
                  {m.status && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{m.status}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleAgentCreated}
        />
      )}
    </>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: 16,
  boxShadow: 'var(--shadow-card)',
};
