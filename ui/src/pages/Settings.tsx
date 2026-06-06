import { InvitePanel } from '../components/InvitePanel.js';
import { PlatformsPanel } from '../components/PlatformsPanel.js';
import { Section } from '../components/ui.js';

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
        title="More controls"
        description="Triage Agent, Strategic Context, Scheduling, co-CEO proposals, and Heartbeat now live under Workspace → Operations."
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Open <strong>Operations</strong> in the sidebar to configure and manage the agent team's automations.
        </div>
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
