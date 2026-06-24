import { useState, useEffect, useCallback } from 'react';
import { getInvite, createAgent, type AgentRow, type AdapterType, type InviteData } from '../api/agents.js';
import { microLabelStyle } from './ui.js';

type Tab = 'invite' | 'manual';
type AgentKind = 'remote-worker' | 'claude-code' | 'codex' | 'openclaw';

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
    ['url', 'Worker URL', false, 'text', 'https://your-vps.example.com:8080/'],
    ['sharedSecret', 'Shared Secret', true, 'password', 'matches NORC_SHARED_SECRET on the worker'],
  ],
};

const ADAPTER_OPTIONS: { value: AdapterType; label: string; description: string }[] = [
  { value: 'claude-local', label: 'Claude Code (local)', description: 'Claude Code CLI running on this machine' },
  { value: 'codex-local', label: 'Codex (local)', description: 'OpenAI Codex CLI running on this machine' },
  { value: 'openclaw', label: 'OpenClaw', description: 'Agent connected via OpenClaw WebSocket gateway' },
  { value: 'claude-api', label: 'Claude API', description: 'Direct Claude API integration' },
  { value: 'http', label: 'Remote Claude Code (HTTP worker)', description: 'Claude Code on a VPS via the norc-claude-worker HTTP service (also any generic HTTP endpoint)' },
];

function buildInvitePrompt(invite: InviteData, kind: AgentKind): string {
  const { norcUrl, token } = invite;

  if (kind === 'remote-worker') {
    return `You are being enrolled as an agent in NORC, an orchestrator that assigns tasks to AI agents from a team's Notion + Slack workspace. Your job right now is to set up the NORC "worker" on THIS machine so NORC can send you tasks here. The worker is a tiny background service that receives a task from NORC, runs you (Claude Code) on it with full tools and \`--dangerously-skip-permissions\`, and reports the result back. It self-registers with NORC over Tailscale, so there are no URLs, ports, or secrets for you to invent.

Do the following:

1. Download the worker into ~/.norc:
\`\`\`bash
mkdir -p ~/.norc && curl -fsSL ${norcUrl}/api/worker -o ~/.norc/worker.mjs
\`\`\`

2. Run it as a DURABLE background service that survives logout and reboots — it must keep running for all future sessions, not just this one. Choose the right mechanism for this OS and set it up:
   - Linux with systemd: a user service (\`systemctl --user enable --now norc-worker\`) plus \`loginctl enable-linger "$USER"\` so it runs without an active login.
   - macOS: a launchd LaunchAgent (\`~/Library/LaunchAgents\`, \`RunAtLoad\` true, \`KeepAlive\` true).
   - Fallback: \`nohup … &\`, and add it to a startup mechanism so it comes back on reboot.
   The service must run \`node ~/.norc/worker.mjs\` with these two environment variables set:
   \`\`\`
   NORC_URL=${norcUrl}
   NORC_REGISTER_TOKEN=${token}
   \`\`\`
   If you want it up immediately first, this works (not reboot-persistent on its own):
   \`\`\`bash
   NORC_URL=${norcUrl} NORC_REGISTER_TOKEN=${token} nohup node ~/.norc/worker.mjs > ~/.norc/worker.log 2>&1 &
   \`\`\`

3. Verify it registered. The log (\`~/.norc/worker.log\` or the service journal) should show \`registered with NORC as "…"\` and \`listening on :8080\`, and \`curl -s localhost:8080/\` should return \`{"ok":true,...}\`. The worker saves its identity to \`~/.norc/credentials.json\`, so every future run and reboot reuses the same agent automatically — you only do this setup once.

4. Reply with: the agent name it registered as, that it is listening, and how you made it persist (the service name + the command to check or restart it).

Prerequisites that should already be true on this machine: Node 22+, the \`claude\` CLI installed and logged in to your subscription, and this machine on the same Tailscale network as NORC. The token above is single-use and is consumed on first registration; the saved credentials handle everything after that, so don't request a new one for this machine.`;
  }

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
  'remote-worker': { heading: 'Paste into Claude Code', body: 'Copy this and send it as a message to Claude Code on the machine you want to enlist (laptop or VPS on your Tailscale network). Claude sets up the worker and registers itself — you don\'t run anything by hand. The machine needs Node 22+ and Claude Code logged in.' },
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
          {([['remote-worker', 'Remote Claude Code'], ['claude-code', 'Claude Code (local)'], ['codex', 'Codex'], ['openclaw', 'OpenClaw']] as [AgentKind, string][]).map(([kind, label]) => (
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
  const [agentKind, setAgentKind] = useState<AgentKind>('remote-worker');
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
