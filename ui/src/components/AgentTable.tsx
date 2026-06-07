import { useState } from 'react';
import { StatusBadge } from './StatusBadge.js';
import { HandshakeButton } from './HandshakeButton.js';
import { deleteAgent, updateAgentConfig, updateAgentLimits, initiateWsPairing, verifyWsPairing, syncAgentToNotion, updateAgentSkills, type AgentRow } from '../api/agents.js';

interface Props {
  agents: AgentRow[];
  loading: boolean;
  provisioned: boolean;
  onPingResult: (id: string, status: 'connected' | 'unreachable', latencyMs: number) => void;
  onDeleted: (id: string) => void;
  onConfigUpdated: (id: string, adapterConfig: Record<string, unknown>) => void;
  onSynced: (id: string, orgDbPageId: string) => void;
}

function NotionSyncCell({ agent, provisioned, onSynced }: { agent: AgentRow; provisioned: boolean; onSynced: (id: string, orgDbPageId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const synced = !!agent.orgDbPageId;

  const handleSync = async () => {
    setBusy(true); setError('');
    try {
      const { orgDbPageId } = await syncAgentToNotion(agent.id);
      onSynced(agent.id, orgDbPageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {synced && <span style={{ fontSize: 11, color: 'var(--accent-green, #3c9)' }} title="Page exists in the Notion Org DB">✓ Synced</span>}
      <button
        onClick={handleSync}
        disabled={busy || !provisioned}
        title={provisioned ? (synced ? 'Update this agent\'s Org DB page' : 'Create this agent\'s Org DB page') : 'Provision the Notion workspace first'}
        style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 4,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text-secondary)', cursor: (busy || !provisioned) ? 'default' : 'pointer',
          opacity: provisioned ? 1 : 0.5,
        }}
      >
        {busy ? 'Syncing…' : synced ? 'Re-sync' : 'Sync'}
      </button>
      {error && <span style={{ fontSize: 10, color: '#e05' }} title={error}>!</span>}
    </div>
  );
}

function timeAgo(epochMs: number | null): string {
  if (!epochMs) return '—';
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const ADAPTER_LABEL: Record<string, string> = {
  'openclaw': 'OpenClaw',
  'claude-api': 'Claude API',
  'http': 'HTTP',
  'claude-local': 'Claude Code',
  'codex-local': 'Codex',
};

function ConfigDetail({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config);
  if (entries.length === 0) return <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>No config</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
      {entries.map(([k, v]) => (
        <span key={k} style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: 'var(--text-dim)' }}>{k}: </span>
          <span style={{ color: v === '[set]' ? 'var(--text-dim)' : 'var(--text-secondary)' }}>
            {v === '[set]' ? '[set]' : String(v)}
          </span>
        </span>
      ))}
    </div>
  );
}

// Config fields shown per adapter type: [key, label, isSecret, inputType]
const ADAPTER_FIELDS: Record<string, [string, string, boolean, string][]> = {
  openclaw: [
    ['url', 'Gateway URL', false, 'text'],
    ['authToken', 'Auth Token', true, 'password'],
  ],
  'claude-api': [
    ['apiKey', 'API Key', true, 'password'],
    ['model', 'Model', false, 'text'],
  ],
  http: [
    ['url', 'Endpoint URL', false, 'text'],
  ],
  'claude-local': [
    ['cwd', 'Working Directory', false, 'text'],
    ['model', 'Model', false, 'text'],
    ['effort', 'Effort', false, 'text'],
    ['command', 'Command', false, 'text'],
  ],
  'codex-local': [
    ['cwd', 'Working Directory', false, 'text'],
    ['model', 'Model', false, 'text'],
    ['command', 'Command', false, 'text'],
  ],
};

function ConfigEditForm({ agent, onSaved }: { agent: AgentRow; onSaved: (config: Record<string, unknown>) => void }) {
  const fields = ADAPTER_FIELDS[agent.adapterType] ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [key] of fields) {
      const v = agent.adapterConfig[key];
      init[key] = v === '[set]' || v === undefined ? '' : String(v);
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Only send fields that have a value; skip blanks for secrets (means "keep existing")
      const patch: Record<string, unknown> = {};
      for (const [key, , isSecret] of fields) {
        const val = values[key]?.trim() ?? '';
        if (val) {
          patch[key] = val;
        } else if (!isSecret) {
          patch[key] = val; // clear non-secret if blank
        }
        // blank secret = no change (omit from patch)
      }
      const result = await updateAgentConfig(agent.id, patch);
      onSaved(result.adapterConfig);
    } catch {
      setError('Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', alignItems: 'flex-end' }}>
        {fields.map(([key, label, isSecret, inputType]) => (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {label}
            </label>
            <input
              type={inputType}
              placeholder={isSecret && agent.adapterConfig[key] === '[set]' ? '(keep existing)' : ''}
              value={values[key] ?? ''}
              onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))}
              style={{
                fontSize: 12, padding: '4px 8px', borderRadius: 4, width: key === 'url' ? 280 : 200,
                border: '1px solid var(--border)', background: 'var(--surface1)',
                color: 'var(--text-primary)', fontFamily: key === 'url' ? 'var(--font-mono)' : 'inherit',
                outline: 'none',
              }}
            />
          </div>
        ))}
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: saving ? 'default' : 'pointer',
            border: '1px solid var(--border)', background: 'var(--accent, #4f7ef7)',
            color: '#fff', fontWeight: 600, alignSelf: 'flex-end',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && <span style={{ fontSize: 11, color: '#e05' }}>{error}</span>}
    </div>
  );
}

function WsPairingPanel({ agent, onUpdated }: { agent: AgentRow; onUpdated: (config: Record<string, unknown>) => void }) {
  const cfg = agent.adapterConfig;
  const hasPaired = cfg['wsPrivateKey'] === '[set]' || typeof cfg['wsPrivateKey'] === 'string';
  const isPending = cfg['wsPairingPending'] === true;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const setup = async () => {
    setBusy(true); setMsg('');
    const result = await initiateWsPairing(agent.id);
    setBusy(false);
    if (result.status === 'paired') {
      setMsg('WebSocket active — using WebSocket for challenge delivery');
      onUpdated({ ...cfg, wsPrivateKey: '[set]', wsPublicKey: '[set]', wsDeviceId: result.deviceId, wsPairingPending: false });
    } else if (result.status === 'pending') {
      setMsg('Pairing request sent — approve it in the OpenClaw Control UI (grant operator role + operator.write scope)');
      onUpdated({ ...cfg, wsPrivateKey: '[set]', wsPublicKey: '[set]', wsDeviceId: result.deviceId, wsPairingPending: true });
    } else {
      setMsg(`Failed: ${result.error ?? 'unknown error'}`);
    }
  };

  const verify = async () => {
    setBusy(true); setMsg('');
    const result = await verifyWsPairing(agent.id);
    setBusy(false);
    if (result.status === 'paired') {
      setMsg('Approved! WebSocket is now active.');
      onUpdated({ ...cfg, wsPairingPending: false });
    } else if (result.status === 'pending') {
      setMsg('Still waiting for approval in OpenClaw Control UI…');
    } else {
      setMsg(`Check failed: ${result.error ?? 'unknown'}`);
    }
  };

  const wsStatus = !hasPaired ? 'not-set'
    : isPending ? 'pending'
    : 'active';

  const statusColor = wsStatus === 'active' ? 'var(--accent-green, #3c9)' : wsStatus === 'pending' ? '#f90' : 'var(--text-dim)';
  const statusLabel = wsStatus === 'active' ? '● WebSocket active' : wsStatus === 'pending' ? '○ Awaiting approval' : '○ Not configured';

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          WebSocket Channel
        </span>
        <span style={{ fontSize: 11, color: statusColor }}>{statusLabel}</span>
        {wsStatus === 'not-set' && (
          <button onClick={setup} disabled={busy} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text-secondary)', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Setting up…' : 'Setup WebSocket'}
          </button>
        )}
        {wsStatus === 'pending' && (
          <button onClick={verify} disabled={busy} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text-secondary)', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Checking…' : 'Check status'}
          </button>
        )}
        {wsStatus === 'active' && (
          <button onClick={setup} disabled={busy} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text-dim)', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Re-pairing…' : 'Re-pair'}
          </button>
        )}
      </div>
      {msg && <div style={{ marginTop: 5, fontSize: 11, color: msg.startsWith('Failed') || msg.startsWith('Check failed') ? '#e05' : 'var(--text-secondary)' }}>{msg}</div>}
    </div>
  );
}

export function AgentTable({ agents, loading, provisioned, onPingResult, onDeleted, onConfigUpdated, onSynced }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleEdit = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDelete = async (agent: AgentRow) => {
    if (!window.confirm(`Remove agent "${agent.name}"?`)) return;
    await deleteAgent(agent.id);
    onDeleted(agent.id);
  };

  if (!loading && agents.length === 0) {
    return (
      <div style={{ padding: '20px 0', color: 'var(--text-secondary)', fontSize: 13 }}>
        No agents registered yet. Use the invite above to connect your first agent.
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          <th style={{ padding: '6px 8px', textAlign: 'left', width: 20 }}></th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Name</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Adapter</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Status</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Latency</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Last Tested</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Connection</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}>Notion</th>
          <th style={{ padding: '6px 12px', textAlign: 'left' }}></th>
        </tr>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: 2 }, (_, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                {Array.from({ length: 9 }, (_, j) => (
                  <td key={j} style={{ padding: '10px 12px' }}>
                    {j > 0 && <div style={{ height: 11, background: 'var(--surface1)', borderRadius: 3, width: j === 1 ? 90 : 50 }} />}
                  </td>
                ))}
              </tr>
            ))
          : agents.flatMap(a => {
              const isExpanded = expanded.has(a.id);
              const rows = [
                <tr
                  key={a.id}
                  style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => toggleExpand(a.id)}
                >
                  <td style={{ padding: '9px 8px', color: 'var(--text-dim)', fontSize: 10, userSelect: 'none' }}>
                    {isExpanded ? '▼' : '▶'}
                  </td>
                  <td style={{ padding: '9px 12px', fontWeight: 500 }}>{a.name}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-secondary)' }}>{ADAPTER_LABEL[a.adapterType] ?? a.adapterType}</td>
                  <td style={{ padding: '9px 12px' }}><StatusBadge status={a.status} /></td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {a.lastLatencyMs != null ? `${a.lastLatencyMs}ms` : '—'}
                  </td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-dim)' }}>{timeAgo(a.lastPingedAt)}</td>
                  <td style={{ padding: '9px 12px' }} onClick={e => e.stopPropagation()}>
                    <HandshakeButton agent={a} onResult={onPingResult} />
                  </td>
                  <td style={{ padding: '9px 12px' }} onClick={e => e.stopPropagation()}>
                    <NotionSyncCell agent={a} provisioned={provisioned} onSynced={onSynced} />
                  </td>
                  <td style={{ padding: '9px 12px' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => handleDelete(a)}
                      title="Remove agent"
                      style={{
                        fontSize: 12, padding: '2px 7px', borderRadius: 4,
                        border: '1px solid var(--border)', background: 'var(--surface2)',
                        color: 'var(--text-dim)', cursor: 'pointer',
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>,
              ];

              if (isExpanded) {
                const isEditing = editing.has(a.id);
                rows.push(
                  <tr key={`${a.id}-config`} style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface1)' }}>
                    <td />
                    <td colSpan={8} style={{ padding: '8px 12px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Adapter Config
                        </span>
                        <button
                          onClick={e => toggleEdit(a.id, e)}
                          style={{
                            fontSize: 10, padding: '1px 7px', borderRadius: 3,
                            border: '1px solid var(--border)', background: isEditing ? 'var(--surface2)' : 'transparent',
                            color: 'var(--text-dim)', cursor: 'pointer',
                          }}
                        >
                          {isEditing ? 'Cancel' : 'Edit'}
                        </button>
                      </div>
                      {isEditing ? (
                        <ConfigEditForm
                          agent={a}
                          onSaved={config => {
                            onConfigUpdated(a.id, config);
                            setEditing(prev => { const n = new Set(prev); n.delete(a.id); return n; });
                          }}
                        />
                      ) : (
                        <ConfigDetail config={a.adapterConfig} />
                      )}
                      {a.adapterType === 'openclaw' && (
                        <WsPairingPanel
                          agent={a}
                          onUpdated={config => onConfigUpdated(a.id, config)}
                        />
                      )}
                      <SkillUpdatePanel agent={a} />
                      <DispatchLimitPanel agent={a} />
                      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
                        ID: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{a.id}</span>
                        &nbsp;&nbsp;Registered: <span style={{ color: 'var(--text-secondary)' }}>{new Date(a.registeredAt).toLocaleString()}</span>
                      </div>
                    </td>
                  </tr>,
                );
              }

              return rows;
            })
        }
      </tbody>
    </table>
  );
}

function DispatchLimitPanel({ agent }: { agent: AgentRow }) {
  const [value, setValue] = useState(String(agent.maxConcurrentRuns ?? 1));
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  const save = async () => {
    const n = parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      setState('error'); setMsg('must be 1–20');
      return;
    }
    setState('busy'); setMsg('');
    try {
      const r = await updateAgentLimits(agent.id, n);
      setState('done');
      setMsg(`saved — up to ${r.maxConcurrentRuns} run${r.maxConcurrentRuns === 1 ? '' : 's'} at once`);
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Max concurrent runs
      </span>
      <input
        type="number"
        min={1}
        max={20}
        value={value}
        onChange={e => setValue(e.target.value)}
        title="How many work runs this agent may have in flight at once. Extra work waits in its queue — and tasks on the SAME project always run one after the other."
        style={{
          fontSize: 12, padding: '3px 8px', borderRadius: 4, width: 60,
          border: '1px solid var(--border)', background: 'var(--surface1)',
          color: 'var(--text-primary)', outline: 'none',
        }}
      />
      <button
        onClick={save}
        disabled={state === 'busy'}
        style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 4,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text-secondary)', cursor: state === 'busy' ? 'default' : 'pointer',
        }}
      >
        {state === 'busy' ? 'Saving…' : 'Save'}
      </button>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        same-project tasks always run sequentially
      </span>
      {msg && (
        <span style={{ fontSize: 11, color: state === 'error' ? 'var(--accent-red)' : 'var(--text-dim)' }}>
          {msg}
        </span>
      )}
    </div>
  );
}

function SkillUpdatePanel({ agent }: { agent: AgentRow }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  const run = async () => {
    setState('busy'); setMsg('');
    try {
      const r = await updateAgentSkills(agent.id);
      setState('done');
      setMsg(r.pushed ? `Pushed skill v${r.version} over the socket` : (r.reason ?? 'Not pushed'));
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : 'failed');
    }
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={run}
        disabled={state === 'busy'}
        title="Tell this agent to re-download its NORC skill"
        style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 4,
          border: '1px solid var(--border)', background: 'var(--surface2)',
          color: 'var(--text-secondary)', cursor: state === 'busy' ? 'default' : 'pointer',
        }}
      >
        {state === 'busy' ? 'Updating…' : 'Update skills'}
      </button>
      {msg && (
        <span style={{ fontSize: 11, color: state === 'error' ? 'var(--accent-red)' : 'var(--text-dim)' }}>
          {msg}
        </span>
      )}
    </div>
  );
}
