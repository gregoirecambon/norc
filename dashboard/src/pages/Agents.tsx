import React, { useEffect, useState, useRef } from 'react';

const API = import.meta.env.VITE_NORC_API ?? '';

interface Agent {
  name: string;
  adapter: string;
  contextLevel: string;
  timeoutMin: number;
  parentAgent: string | null;
  capabilities: string[];
  status: string;
  lastActive: string | null;
  registeredAt: string | null;
}

interface InviteData {
  norcUrl: string;
  prompt: string;
}

type PingState = 'idle' | 'pending' | 'ok' | 'error';
interface PingResult { latencyMs?: number; message?: string }

function useLocalStorage(key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [val, setVal] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? defaultValue; }
    catch { return defaultValue; }
  });
  const set = (v: boolean) => { setVal(v); localStorage.setItem(key, JSON.stringify(v)); };
  return [val, set];
}

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [inviteLoading, setInviteLoading] = useState(true);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [panelOpen, setPanelOpen] = useLocalStorage('norc-invite-panel-open', true);
  const [pingStates, setPingStates] = useState<Record<string, PingState>>({});
  const [pingResults, setPingResults] = useState<Record<string, PingResult>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(`${API}/api/agents`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: Agent[]) => {
        setAgents(data);
        // If agents exist, default panel closed unless user explicitly opened it
        if (data.length > 0) {
          const stored = localStorage.getItem('norc-invite-panel-open');
          if (stored === null) setPanelOpen(false);
        }
      })
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));

    fetch(`${API}/api/agents/invite`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((data: InviteData) => setInvite(data))
      .catch((err: Error) => setInviteError(err.message || 'Invite unavailable'))
      .finally(() => setInviteLoading(false));
  }, []);

  const handleCopy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API denied — select textarea for manual copy
      textareaRef.current?.select();
    }
  };

  const handlePing = async (agentName: string) => {
    setPingStates(s => ({ ...s, [agentName]: 'pending' }));
    setPingResults(r => ({ ...r, [agentName]: {} }));
    try {
      const res = await fetch(`${API}/api/agents/${encodeURIComponent(agentName)}/ping`, { method: 'POST' });
      const body = await res.json();
      if (res.ok && body.ok) {
        setPingStates(s => ({ ...s, [agentName]: 'ok' }));
        setPingResults(r => ({ ...r, [agentName]: { latencyMs: body.latencyMs } }));
      } else {
        setPingStates(s => ({ ...s, [agentName]: 'error' }));
        const msg = body.message ?? body.error ?? 'Error';
        setPingResults(r => ({ ...r, [agentName]: { message: msg.slice(0, 40) } }));
      }
    } catch {
      setPingStates(s => ({ ...s, [agentName]: 'error' }));
      setPingResults(r => ({ ...r, [agentName]: { message: 'Unreachable' } }));
    }
  };

  // Build lineage tree (max 2 levels)
  const roots = agents.filter(a => !a.parentAgent);
  const childrenOf = (name: string) => agents.filter(a => a.parentAgent === name);

  const pingColor = (state: PingState) => {
    if (state === 'ok') return 'var(--accent-green)';
    if (state === 'error') return 'var(--accent-red, #f87171)';
    return 'var(--text-dim)';
  };

  const pingLabel = (name: string) => {
    const state = pingStates[name] ?? 'idle';
    const result = pingResults[name] ?? {};
    if (state === 'pending') return '○  Testing…';
    if (state === 'ok') return `●  OK  ${result.latencyMs}ms`;
    if (state === 'error') return `●  ${result.message ?? 'Error'}`;
    return 'Test';
  };

  const renderAgentRow = (a: Agent, indent = 0) => (
    <React.Fragment key={a.name}>
      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
        <td style={{ padding: '8px 12px', fontWeight: 500, paddingLeft: 12 + indent * 16 }}>
          {indent > 0 && <span style={{ color: 'var(--text-dim)', marginRight: 6 }}>↳</span>}
          {a.name}
        </td>
        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{a.adapter}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{a.contextLevel}</td>
        <td style={{ padding: '8px 12px' }}>
          <span style={{ color: a.status === 'Available' ? 'var(--accent-green)' : a.status === 'Busy' ? 'var(--accent-amber)' : 'var(--text-dim)' }}>
            ● {a.status}
          </span>
        </td>
        <td style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>{a.lastActive ? new Date(a.lastActive).toLocaleString() : '—'}</td>
        <td style={{ padding: '8px 12px' }}>
          <button
            disabled={pingStates[a.name] === 'pending'}
            onClick={() => handlePing(a.name)}
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--surface2)',
              color: pingColor(pingStates[a.name] ?? 'idle'),
              cursor: pingStates[a.name] === 'pending' ? 'default' : 'pointer',
              opacity: pingStates[a.name] === 'pending' ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {pingLabel(a.name)}
          </button>
        </td>
      </tr>
      {indent < 1 && childrenOf(a.name).map(child => renderAgentRow(child, 1))}
    </React.Fragment>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      {/* Invite panel — always rendered above the table */}
      <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          style={{
            width: '100%', textAlign: 'left', padding: '10px 14px',
            background: 'var(--surface2)', border: 'none', cursor: 'pointer',
            color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{panelOpen ? '▼' : '▶'}</span>
          Invite an Agent
        </button>

        {panelOpen && (
          <div style={{ padding: 14, background: 'var(--surface1)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Paste this into your agent's system prompt (OpenClaw persona, Cursor rules file, Claude Code CLAUDE.md, etc.).
              The agent will self-register with NORC on first run. The token is one-time use — a new one is generated after each registration.
            </p>

            {inviteLoading ? (
              <div style={{ height: 120, background: 'var(--surface2)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                Loading…
              </div>
            ) : inviteError ? (
              <div style={{ padding: 10, background: 'var(--surface2)', borderRadius: 4, color: 'var(--accent-red, #f87171)', fontSize: 12 }}>
                Invite unavailable — set <code>NORC_PUBLIC_URL</code> in your .env and restart ({inviteError})
              </div>
            ) : (
              <>
                <textarea
                  ref={textareaRef}
                  readOnly
                  value={invite?.prompt ?? ''}
                  style={{
                    width: '100%', height: 160, fontFamily: 'monospace', fontSize: 11,
                    background: 'var(--surface2)', color: 'var(--text-primary)',
                    border: '1px solid var(--border)', borderRadius: 4, padding: 8,
                    resize: 'vertical', boxSizing: 'border-box',
                  }}
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    onClick={handleCopy}
                    disabled={!invite}
                    style={{
                      fontSize: 12, padding: '5px 12px', borderRadius: 4,
                      background: copied ? 'var(--accent-green)' : 'var(--surface2)',
                      border: '1px solid var(--border)', color: copied ? '#fff' : 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  {!copied && (
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      Or select all and press ⌘C / Ctrl+C
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <h1 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Registered Agents</h1>

      {!loading && agents.length === 0 ? (
        <div style={{ padding: '20px 0', color: 'var(--text-secondary)', fontSize: 13 }}>
          No agents registered. Run <code style={{ background: 'var(--surface2)', padding: '1px 5px', borderRadius: 4 }}>norc agent add &lt;name&gt;</code> or use the invite prompt above.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Name</th>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Adapter</th>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Context</th>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Status</th>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Last Active</th>
              <th style={{ padding: '6px 12px', textAlign: 'left' }}>Connection</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 2 }, (_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    {Array.from({ length: 6 }, (_, j) => (
                      <td key={j} style={{ padding: '8px 12px' }}>
                        <div style={{ height: 12, background: 'var(--surface2)', borderRadius: 3, width: j === 0 ? 80 : 50 }} />
                      </td>
                    ))}
                  </tr>
                ))
              : roots.map(a => renderAgentRow(a))}
          </tbody>
        </table>
      )}
    </div>
  );
}
