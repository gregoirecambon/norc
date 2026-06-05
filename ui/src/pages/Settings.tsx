import { useState } from 'react';
import { InvitePanel } from '../components/InvitePanel.js';
import { PlatformsPanel } from '../components/PlatformsPanel.js';
import { provisionCompanyDb } from '../api/notion.js';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {description && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>{description}</div>
        )}
      </div>
      <div style={{ padding: '18px 22px' }}>
        {children}
      </div>
    </div>
  );
}

function CompanyDbPanel() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  const add = async () => {
    setState('busy'); setMsg('');
    try {
      const res = await provisionCompanyDb();
      setState('done');
      setMsg(res.created ? 'Company DB created — strategic agents now get company context.' : 'Company DB already exists.');
    } catch (err) {
      setState('error');
      setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <button
        onClick={add}
        disabled={state === 'busy'}
        style={{
          fontSize: 13, fontWeight: 500, padding: '8px 14px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)',
          cursor: state === 'busy' ? 'default' : 'pointer',
        }}
      >
        {state === 'busy' ? 'Adding…' : 'Add Company DB'}
      </button>
      {msg && (
        <div style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: '0 0 24px' }}>
        Settings
      </h1>

      <Section
        title="Connect an Agent"
        description="Paste this prompt into your agent's CLAUDE.md, system prompt, or Cursor rules file. The agent self-registers with NORC on first run."
      >
        <InvitePanel hasAgents={false} embedded />
      </Section>

      <Section
        title="Platforms"
        description="External services agents can be granted access to. Once approved, agents retrieve the API key via GET /api/me/platforms."
      >
        <PlatformsPanel agents={[]} embedded />
      </Section>

      <Section
        title="Strategic Context"
        description="Adds a Company database (Vision / Values / Strategy) for workspaces provisioned before strategic context existed. Only agents with Context Level = strategic see it. Safe to click — it's a no-op if the DB already exists."
      >
        <CompanyDbPanel />
      </Section>

      <Section title="About">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[['Version', 'v0.1'], ['Project', 'NORC Orchestrator'], ['Stack', 'React · TypeScript · Vite']].map(([k, v]) => (
            <div key={k} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '9px 0', borderBottom: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{k}</span>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: k === 'Version' ? 'var(--font-mono)' : 'inherit' }}>{v}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
