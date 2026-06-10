import { useState, useEffect, useCallback } from 'react';
import { getInvite, createAgent, type AgentRow, type AdapterType, type InviteData } from '../api/agents.js';
import { microLabelStyle } from './ui.js';

type Tab = 'invite' | 'manual';
type AgentKind = 'claude-code' | 'codex' | 'openclaw';

interface Props {
  onClose: () => void;
  onCreated: (agent: AgentRow) => void;
}

// [key, label, isSecret, inputType, placeholder]
type FieldSpec = [string, string, boolean, string, string];

const MANUAL_FIELDS: Record<AdapterType, FieldSpec[]> = {
  'claude-local': [
    ['cwd', 'Working Directory', false, 'text', '/path/to/project'],
    ['model', 'Model', false, 'text', 'claude-opus-4-6'],
    ['effort', 'Effort', false, 'text', 'medium'],
    ['command', 'Command', false, 'text', 'claude'],
  ],
  'codex-local': [
    ['cwd', 'Working Directory', false, 'text', '/path/to/project'],
    ['model', 'Model', false, 'text', 'gpt-5.3-codex'],
    ['command', 'Command', false, 'text', 'codex'],
  ],
  'openclaw': [
    ['url', 'Gateway URL', false, 'text', 'wss://your-host'],
    ['authToken', 'Auth Token', true, 'password', ''],
  ],
  'claude-api': [
    ['apiKey', 'API Key', true, 'password', 'sk-ant-...'],
    ['model', 'Model', false, 'text', 'claude-opus-4-6'],
  ],
  'http': [
    ['url', 'Endpoint URL', false, 'text', 'https://...'],
  ],
};

const ADAPTER_OPTIONS: { value: AdapterType; label: string; description: string }[] = [
  { value: 'claude-local', label: 'Claude Code (local)', description: 'Claude Code CLI running on this machine' },
  { value: 'codex-local', label: 'Codex (local)', description: 'OpenAI Codex CLI running on this machine' },
  { value: 'openclaw', label: 'OpenClaw', description: 'Agent connected via OpenClaw WebSocket gateway' },
  { value: 'claude-api', label: 'Claude API', description: 'Direct Claude API integration' },
  { value: 'http', label: 'HTTP', description: 'Generic HTTP endpoint' },
];

function buildInvitePrompt(invite: InviteData, kind: AgentKind): string {
  const { norcUrl, token } = invite;

  if (kind === 'openclaw') {
    return `# Norc Registration — OpenClaw Agent

## Step 1 — Register with Norc

Run this command once (replace the placeholders):

\`\`\`bash
curl -s -X POST ${norcUrl}/api/agents/register \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "YOUR_AGENT_SLUG",
    "adapterType": "openclaw",
    "adapterConfig": {
      "url": "YOUR_OPENCLAW_WS_URL"
    },
    "metadata": {}
  }'
\`\`\`

- YOUR_AGENT_SLUG: lowercase slug matching your OpenClaw agent ID (e.g. emilien)
- YOUR_OPENCLAW_WS_URL: your gateway WebSocket URL (e.g. wss://your-host.ts.net)

## Step 2 — Configure your gateway with the returned authToken

\`\`\`bash
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token YOUR_AUTH_TOKEN_FROM_RESPONSE
openclaw gateway restart
\`\`\`

## Step 3 — Download your NORC skill

This is the protocol for handling tasks NORC sends you and reporting results back:

\`\`\`bash
curl -s ${norcUrl}/api/skill -o ~/.norc/skills/norc.md
\`\`\`

NORC can later push you an updated version (the "Update skills" button).

The token is single-use and rotates automatically after registration.`;
  }

  const adapterType = kind === 'claude-code' ? 'claude-local' : 'codex-local';
  const command = kind === 'claude-code' ? 'claude' : 'codex';
  const name = kind === 'claude-code' ? 'claude-$(whoami)' : 'codex-$(whoami)';

  return `# Norc Registration

Run this command once to register this agent with Norc:

\`\`\`bash
curl -s -X POST ${norcUrl}/api/agents/register \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "${name}",
    "adapterType": "${adapterType}",
    "adapterConfig": {
      "cwd": "'"$(pwd)"'",
      "command": "${command}"
    },
    "metadata": {}
  }'
\`\`\`

Then download your NORC skill (the protocol for handling tasks + reporting back):

\`\`\`bash
curl -s ${norcUrl}/api/skill -o ~/.norc/skills/norc.md
\`\`\`

After running these once, the agent is visible in the Norc dashboard and ready to receive tasks. The token is single-use and rotates automatically.`;
}

const KIND_TIP: Record<AgentKind, { heading: string; body: string }> = {
  'claude-code': { heading: 'CLAUDE.md', body: 'Paste this into your project\'s CLAUDE.md — Claude Code runs the commands on first run, including downloading the NORC skill.' },
  'codex':       { heading: 'Instructions file', body: 'Paste this into your ~/.codex/instructions.md or a project-level instructions file. It registers the agent and downloads the NORC skill.' },
  'openclaw':    { heading: 'Terminal', body: 'Run these commands in your terminal. Step 2 is required (auth) and Step 3 downloads the NORC skill.' },
};

function InviteTab({
  invite, loading, agentKind, onKindChange, copied, onCopy,
}: {
  invite: InviteData | null;
  loading: boolean;
  agentKind: AgentKind;
  onKindChange: (k: AgentKind) => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Agent type selector */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
          Agent Type
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {([['claude-code', 'Claude Code'], ['codex', 'Codex'], ['openclaw', 'OpenClaw']] as [AgentKind, string][]).map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => onKindChange(kind)}
              style={{
                padding: '7px 16px', borderRadius: 'var(--radius-md)',
                border: `1.5px solid ${agentKind === kind ? 'var(--primary)' : 'var(--border)'}`,
                background: agentKind === kind ? 'var(--tint-lavender)' : 'var(--surface1)',
                color: agentKind === kind ? 'var(--primary)' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
                transition: 'all 120ms',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Where to paste tip */}
      <div style={{
        padding: '10px 12px', borderRadius: 'var(--radius-sm)',
        background: 'var(--tint-lavender)', fontSize: 12,
        color: 'var(--tint-lavender-text)', lineHeight: 1.5,
      }}>
        <strong>{KIND_TIP[agentKind].heading}</strong>
        {' — '}
        {KIND_TIP[agentKind].body}
      </div>

      {/* Prompt */}
      {loading ? (
        <div style={{
          height: 200, background: 'var(--surface1)', borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 13,
        }}>
          Generating token…
        </div>
      ) : invite ? (
        <>
          <textarea
            readOnly
            value={buildInvitePrompt(invite, agentKind)}
            style={{
              width: '100%', height: 220, boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)', fontSize: 11.5,
              background: 'var(--surface1)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '10px 12px', resize: 'vertical', lineHeight: 1.65,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={onCopy}
              style={{
                padding: '8px 18px', borderRadius: 'var(--radius-md)',
                border: 'none',
                background: copied ? 'var(--tint-mint)' : 'var(--primary)',
                color: copied ? 'var(--tint-mint-text)' : 'var(--on-primary)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
                transition: 'all 150ms',
              }}
            >
              {copied ? '✓ Copied!' : 'Copy prompt'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Token: <code style={{ fontFamily: 'var(--font-mono)' }}>{invite.token.slice(0, 12)}…</code> — one-time, auto-rotates
            </span>
          </div>
        </>
      ) : (
        <div style={{
          padding: '12px 14px', background: '#fde8e8',
          borderRadius: 'var(--radius-sm)', color: 'var(--accent-red)', fontSize: 13,
        }}>
          Token unavailable — make sure <code>NORC_PUBLIC_URL</code> is set and the server is running.
        </div>
      )}
    </div>
  );
}

function ManualTab({
  name, onNameChange, adapterType, onAdapterChange,
  fieldValues, onFieldChange, saving, error, onCancel, onCreate,
}: {
  name: string;
  onNameChange: (v: string) => void;
  adapterType: AdapterType;
  onAdapterChange: (t: AdapterType) => void;
  fieldValues: Record<string, string>;
  onFieldChange: (key: string, val: string) => void;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const fields = MANUAL_FIELDS[adapterType];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Name */}
      <div>
        <label style={labelStyle}>Name</label>
        <input
          type="text"
          placeholder="my-claude-code"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
          spellCheck={false}
        />
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          Lowercase letters, digits, hyphens, underscores
        </div>
      </div>

      {/* Adapter type */}
      <div>
        <label style={labelStyle}>Adapter Type</label>
        <select
          value={adapterType}
          onChange={e => onAdapterChange(e.target.value as AdapterType)}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', cursor: 'pointer' }}
        >
          {ADAPTER_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
          {ADAPTER_OPTIONS.find(o => o.value === adapterType)?.description}
        </div>
      </div>

      {/* Dynamic config fields */}
      {fields.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Configuration
          </div>
          {fields.map(([key, fieldLabel, , inputType, placeholder]) => (
            <div key={key}>
              <label style={labelStyle}>{fieldLabel}</label>
              <input
                type={inputType}
                placeholder={placeholder}
                value={fieldValues[key] ?? ''}
                onChange={e => onFieldChange(key, e.target.value)}
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', fontFamily: key === 'cwd' || key === 'url' || key === 'command' ? 'var(--font-mono)' : 'inherit' }}
                spellCheck={false}
              />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--accent-red)', padding: '8px 12px', background: '#fde8e8', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
        <button onClick={onCancel} style={cancelBtnStyle}>Cancel</button>
        <button onClick={onCreate} disabled={saving} style={primaryBtnStyle(saving)}>
          {saving ? 'Adding…' : 'Add Agent'}
        </button>
      </div>
    </div>
  );
}

export function AddAgentModal({ onClose, onCreated }: Props) {
  const [tab, setTab] = useState<Tab>('invite');

  // Invite tab state
  const [agentKind, setAgentKind] = useState<AgentKind>('claude-code');
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [inviteLoading, setInviteLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Manual tab state
  const [name, setName] = useState('');
  const [adapterType, setAdapterType] = useState<AdapterType>('claude-local');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    getInvite().then(setInvite).catch(() => {}).finally(() => setInviteLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(buildInvitePrompt(invite, agentKind));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [invite, agentKind]);

  const handleAdapterChange = (type: AdapterType) => {
    setAdapterType(type);
    setFieldValues({});
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setCreateError('Name is required'); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) { setCreateError('Name must be lowercase letters, digits, hyphens, underscores only'); return; }

    setSaving(true);
    setCreateError('');
    try {
      const config: Record<string, unknown> = {};
      for (const [key] of MANUAL_FIELDS[adapterType]) {
        const val = (fieldValues[key] ?? '').trim();
        if (val) config[key] = val;
      }
      const agent = await createAgent({ name: trimmed, adapterType, adapterConfig: config });
      onCreated(agent);
      onClose();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create agent');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          width: '100%', maxWidth: 600,
          boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>Add Agent</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', padding: '2px 6px', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 20, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', paddingLeft: 20 }}>
          {([['invite', 'Invite Prompt'], ['manual', 'Manual Setup']] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: 'none', border: 'none', padding: '10px 14px',
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                color: tab === t ? 'var(--primary)' : 'var(--text-dim)',
                borderBottom: `2px solid ${tab === t ? 'var(--primary)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: 20 }}>
          {tab === 'invite' ? (
            <InviteTab
              invite={invite}
              loading={inviteLoading}
              agentKind={agentKind}
              onKindChange={setAgentKind}
              copied={copied}
              onCopy={handleCopy}
            />
          ) : (
            <ManualTab
              name={name}
              onNameChange={setName}
              adapterType={adapterType}
              onAdapterChange={handleAdapterChange}
              fieldValues={fieldValues}
              onFieldChange={(key, val) => setFieldValues(prev => ({ ...prev, [key]: val }))}
              saving={saving}
              error={createError}
              onCancel={onClose}
              onCreate={handleCreate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const labelStyle = microLabelStyle;

const inputStyle: React.CSSProperties = {
  fontSize: 13, padding: '7px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface1)',
  color: 'var(--text-primary)',
  outline: 'none',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--surface1)',
  color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};

const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '7px 18px', borderRadius: 'var(--radius-md)',
  border: 'none', background: 'var(--primary)',
  color: 'var(--on-primary)', fontSize: 13, fontWeight: 500,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
});
