import { useState, useEffect } from 'react';
import { InvitePanel } from '../components/InvitePanel.js';
import { PlatformsPanel } from '../components/PlatformsPanel.js';
import { provisionCompanyDb } from '../api/notion.js';
import { getSettings, saveSettings, testTriageConnection, testNotification, type NorcSettings } from '../api/settings.js';

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

const inputStyle: React.CSSProperties = {
  fontSize: 13, padding: '8px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)', width: '100%',
};
const labelStyle: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };

function OrchestratorPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [testState, setTestState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const test = async () => {
    if (!s) return;
    setTestState('busy'); setTestMsg('');
    try {
      const r = await testTriageConnection({
        provider: s.orchestratorProvider,
        model: s.orchestratorModel,
        baseUrl: s.orchestratorBaseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (r.ok) { setTestState('ok'); setTestMsg(`Connected${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ''}${r.sample ? ` — replied “${r.sample}”` : ''}`); }
      else { setTestState('error'); setTestMsg(r.error ?? 'Connection failed'); }
    } catch (err) {
      setTestState('error'); setTestMsg(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const patch = {
        orchestratorEnabled: s.orchestratorEnabled,
        orchestratorProvider: s.orchestratorProvider,
        orchestratorBaseUrl: s.orchestratorBaseUrl,
        orchestratorModel: s.orchestratorModel,
        orchestratorSystemPrompt: s.orchestratorSystemPrompt,
        autoRouteThreshold: s.autoRouteThreshold,
        runTimeoutSec: s.runTimeoutSec,
        ...(apiKey.trim() ? { orchestratorApiKey: apiKey.trim() } : {}),
      };
      const next = await saveSettings(patch);
      setS(next); setApiKey(''); setState('saved'); setMsg('Saved.');
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;

  const isOpenAI = s.orchestratorProvider === 'openai';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={s.orchestratorEnabled} onChange={e => setS({ ...s, orchestratorEnabled: e.target.checked })} />
        Enable the NORC Triage Agent (triage unassigned tasks &amp; comments)
      </label>

      <div>
        <label style={labelStyle}>Provider</label>
        <select style={inputStyle} value={s.orchestratorProvider} onChange={e => setS({ ...s, orchestratorProvider: e.target.value as NorcSettings['orchestratorProvider'] })}>
          <option value="anthropic">Anthropic (direct)</option>
          <option value="openai">OpenAI-compatible (LiteLLM / proxy)</option>
        </select>
      </div>

      {isOpenAI && (
        <div>
          <label style={labelStyle}>Base URL (LiteLLM / OpenAI-compatible endpoint)</label>
          <input style={inputStyle} placeholder="http://localhost:4000" value={s.orchestratorBaseUrl ?? ''} onChange={e => setS({ ...s, orchestratorBaseUrl: e.target.value })} />
        </div>
      )}

      <div>
        <label style={labelStyle}>
          {isOpenAI ? 'API key (LiteLLM key — optional)' : 'Anthropic API key'} {s.orchestratorApiKeySet && <span style={{ color: 'var(--text-tertiary, #999)' }}>(set — leave blank to keep)</span>}
        </label>
        <input style={inputStyle} type="password" placeholder={s.orchestratorApiKeySet ? '••••••••' : (isOpenAI ? 'sk-… (optional)' : 'sk-ant-…')} value={apiKey} onChange={e => setApiKey(e.target.value)} />
      </div>

      <div>
        <label style={labelStyle}>Model {isOpenAI && <span style={{ color: 'var(--text-tertiary, #999)' }}>(as your proxy names it, e.g. gpt-4o or claude-sonnet-4-6)</span>}</label>
        <input style={inputStyle} value={s.orchestratorModel} onChange={e => setS({ ...s, orchestratorModel: e.target.value })} />
      </div>

      <div>
        <label style={labelStyle}>Auto-route threshold: <strong>{s.autoRouteThreshold.toFixed(2)}</strong> — at or above this confidence the Triage Agent dispatches directly; below it only suggests.</label>
        <input type="range" min={0} max={1} step={0.05} value={s.autoRouteThreshold} onChange={e => setS({ ...s, autoRouteThreshold: parseFloat(e.target.value) })} style={{ width: '100%' }} />
      </div>

      <div>
        <label style={labelStyle}>Response timeout (seconds, min 60) — if a routed agent doesn't report back in this time, NORC frees it, tells the team in Notion, and re-routes to another agent.</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={60} value={s.runTimeoutSec}
          onChange={e => setS({ ...s, runTimeoutSec: parseInt(e.target.value || '300', 10) })} />
      </div>

      <div>
        <label style={labelStyle}>Co-CEO system prompt (optional — overrides the default persona)</label>
        <textarea style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit', resize: 'vertical' }}
          value={s.orchestratorSystemPrompt ?? ''} onChange={e => setS({ ...s, orchestratorSystemPrompt: e.target.value })}
          placeholder="You are the NORC Triage Agent, a co-CEO who…" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={state === 'busy'} style={{
          fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--accent, var(--surface1))', color: 'var(--text-primary)',
          cursor: state === 'busy' ? 'default' : 'pointer',
        }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        <button onClick={test} disabled={testState === 'busy'} style={{
          fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)',
          cursor: testState === 'busy' ? 'default' : 'pointer',
        }}>{testState === 'busy' ? 'Testing…' : 'Test connection'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
        {testMsg && <span style={{ fontSize: 12.5, color: testState === 'error' ? 'var(--danger, #d33)' : 'var(--success, #2a8)' }}>{testState === 'ok' ? '✓ ' : '✗ '}{testMsg}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary, #999)' }}>
        Test uses the values above (leave the key blank to test with the saved one). It doesn't save.
      </div>
    </div>
  );
}

function HeartbeatPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const next = await saveSettings({ heartbeatEnabled: s.heartbeatEnabled, heartbeatIntervalSec: s.heartbeatIntervalSec });
      setS(next); setState('saved'); setMsg('Saved.');
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={s.heartbeatEnabled} onChange={e => setS({ ...s, heartbeatEnabled: e.target.checked })} />
        Periodically ping agents and reconcile their status
      </label>
      <div>
        <label style={labelStyle}>Interval (seconds, min 10)</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={10} value={s.heartbeatIntervalSec}
          onChange={e => setS({ ...s, heartbeatIntervalSec: parseInt(e.target.value || '60', 10) })} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={state === 'busy'} style={{
          fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)',
          cursor: state === 'busy' ? 'default' : 'pointer',
        }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
      </div>
    </div>
  );
}

function NotificationsPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [pass, setPass] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [testState, setTestState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const next = await saveSettings({
        notifyEnabled: s.notifyEnabled,
        notifyEmail: s.notifyEmail,
        smtpHost: s.smtpHost,
        smtpPort: s.smtpPort,
        smtpUser: s.smtpUser,
        smtpFrom: s.smtpFrom,
        ...(pass.trim() ? { smtpPass: pass.trim() } : {}),
      });
      setS(next); setPass(''); setState('saved'); setMsg('Saved.');
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  const test = async () => {
    setTestState('busy'); setTestMsg('');
    try {
      const r = await testNotification();
      if (r.ok) { setTestState('ok'); setTestMsg('SMTP reachable'); }
      else { setTestState('error'); setTestMsg(r.error ?? 'Connection failed'); }
    } catch (err) {
      setTestState('error'); setTestMsg(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={s.notifyEnabled} onChange={e => setS({ ...s, notifyEnabled: e.target.checked })} />
        Also email me when the Triage Agent is unsure (the Notion @mention happens regardless)
      </label>
      <div>
        <label style={labelStyle}>Recipient email (defaults to the SMTP user if blank)</label>
        <input style={inputStyle} placeholder="you@company.com" value={s.notifyEmail ?? ''} onChange={e => setS({ ...s, notifyEmail: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 2 }}>
          <label style={labelStyle}>SMTP host</label>
          <input style={inputStyle} placeholder="smtp.gmail.com" value={s.smtpHost ?? ''} onChange={e => setS({ ...s, smtpHost: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Port</label>
          <input style={inputStyle} type="number" placeholder="587" value={s.smtpPort ?? ''} onChange={e => setS({ ...s, smtpPort: e.target.value ? parseInt(e.target.value, 10) : null })} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>SMTP username</label>
        <input style={inputStyle} placeholder="you@company.com" value={s.smtpUser ?? ''} onChange={e => setS({ ...s, smtpUser: e.target.value })} />
      </div>
      <div>
        <label style={labelStyle}>
          SMTP password {s.smtpPassSet && <span style={{ color: 'var(--text-tertiary, #999)' }}>(set — leave blank to keep)</span>}
        </label>
        <input style={inputStyle} type="password" placeholder={s.smtpPassSet ? '••••••••' : 'app password'} value={pass} onChange={e => setPass(e.target.value)} />
      </div>
      <div>
        <label style={labelStyle}>From address (optional — defaults to the SMTP user)</label>
        <input style={inputStyle} placeholder="NORC <bot@company.com>" value={s.smtpFrom ?? ''} onChange={e => setS({ ...s, smtpFrom: e.target.value })} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={state === 'busy'} style={{
          fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--accent, var(--surface1))', color: 'var(--text-primary)',
          cursor: state === 'busy' ? 'default' : 'pointer',
        }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        <button onClick={test} disabled={testState === 'busy'} style={{
          fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)',
          cursor: testState === 'busy' ? 'default' : 'pointer',
        }}>{testState === 'busy' ? 'Testing…' : 'Test connection'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
        {testMsg && <span style={{ fontSize: 12.5, color: testState === 'error' ? 'var(--danger, #d33)' : 'var(--success, #2a8)' }}>{testState === 'ok' ? '✓ ' : '✗ '}{testMsg}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary, #999)' }}>
        Save before testing — the test verifies the stored SMTP settings.
      </div>
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
        title="NORC Triage Agent (co-CEO)"
        description="When a task or comment arrives with no agent assigned, the Triage Agent triages it: auto-routes to the best agent above the confidence threshold, otherwise suggests one to the creator. Use Anthropic directly or any OpenAI-compatible endpoint (e.g. a LiteLLM proxy)."
      >
        <OrchestratorPanel />
      </Section>

      <Section
        title="Strategic Context"
        description="Adds a Company database (Vision / Values / Strategy) for workspaces provisioned before strategic context existed. Only agents with Context Level = strategic see it. Safe to click — it's a no-op if the DB already exists."
      >
        <CompanyDbPanel />
      </Section>

      <Section
        title="Notifications"
        description="When the Triage Agent is unsure (suggests an agent, asks who should take a task, or has no one to try), it comments on the exact item and @mentions the person who triggered the event — so they're notified natively in Notion. This panel adds an OPTIONAL email on top of that, for when you're not watching Notion. Any SMTP works — a Gmail app password, your domain's SMTP, or a transactional service."
      >
        <NotificationsPanel />
      </Section>

      <Section
        title="Heartbeat"
        description="Keeps agent Status accurate: NORC pings each agent on a schedule and reflects reachable → Available, unreachable → Offline on the Org DB. Agents mid-task (or marked Busy) are never disturbed."
      >
        <HeartbeatPanel />
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
