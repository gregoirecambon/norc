import { useEffect, useState } from 'react';
import { InvitePanel } from '../components/InvitePanel.js';
import { PlatformsPanel } from '../components/PlatformsPanel.js';
import { Section, Tabs, btnStyle, inputStyle, labelStyle } from '../components/ui.js';
import { getVersion } from '../api/version.js';
import {
  getSettings, saveSettings, sendTestEmail,
  type NorcSettings, type TestEmailResult,
} from '../api/settings.js';

type Tab = 'general' | 'email';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(v => setVersion(`v${v.current}`)).catch(() => {});
  }, []);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: '0 0 24px' }}>
        Settings
      </h1>

      <Tabs
        tabs={[{ id: 'general' as Tab, label: 'General' }, { id: 'email' as Tab, label: 'Email' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'general' && <GeneralTab version={version} />}
      {tab === 'email' && <EmailTab />}
    </div>
  );
}

function GeneralTab({ version }: { version: string | null }) {
  return (
    <>
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
          {[['Version', version ?? '…'], ['Project', 'NORC Orchestrator'], ['Stack', 'React · TypeScript · Vite']].map(([k, v]) => (
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
    </>
  );
}

interface EmailForm {
  host: string;
  port: string;
  user: string;
  pass: string;       // blank = keep the stored one
  from: string;
  secure: boolean;
}

function EmailTab() {
  const [settings, setSettings] = useState<NorcSettings | null>(null);
  const [form, setForm] = useState<EmailForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      setForm({
        host: s.smtpHost ?? '',
        port: String(s.smtpPort),
        user: s.smtpUser ?? '',
        pass: '',
        from: s.smtpFrom ?? '',
        secure: s.smtpSecure,
      });
    }).catch(() => setNotice({ kind: 'err', text: 'Could not load settings.' }));
  }, []);

  if (!form) {
    return <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>;
  }

  const set = (patch: Partial<EmailForm>) => setForm(f => ({ ...f!, ...patch }));
  const port = parseInt(form.port, 10);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const statusPill = (() => {
    const src = settings?.smtpSource ?? null;
    const map = {
      settings: { text: 'Email enabled — configured here', bg: 'var(--tint-mint)', fg: 'var(--tint-mint-text)' },
      env: { text: 'Email enabled — via SMTP_* env vars (saving here overrides them)', bg: 'var(--tint-sky)', fg: 'var(--tint-sky-text)' },
      none: { text: 'Email disabled — invites fall back to copyable links', bg: 'var(--tint-graphite)', fg: 'var(--tint-graphite-text)' },
    } as const;
    return map[src ?? 'none'];
  })();

  const save = () => {
    if (!portValid || saving) return;
    setSaving(true);
    setNotice(null);
    saveSettings({
      smtpHost: form.host.trim() || null,
      smtpPort: port,
      smtpUser: form.user.trim() || null,
      smtpFrom: form.from.trim() || null,
      smtpSecure: form.secure,
      // Blank password keeps the stored one; clearing the host clears intent anyway.
      ...(form.pass.trim() ? { smtpPass: form.pass } : {}),
      ...(form.host.trim() ? {} : { smtpPass: null }),
    })
      .then(s => {
        setSettings(s);
        set({ pass: '' });
        setNotice({ kind: 'ok', text: 'Saved. Team invites will now be emailed.' });
      })
      .catch(() => setNotice({ kind: 'err', text: 'Save failed — check the values and try again.' }))
      .finally(() => setSaving(false));
  };

  const test = () => {
    if (testing) return;
    setTesting(true);
    setNotice(null);
    // Carry unsaved form values so you can test before saving.
    sendTestEmail({
      ...(form.host.trim() ? { host: form.host.trim() } : {}),
      ...(portValid ? { port } : {}),
      user: form.user.trim() || null,
      ...(form.pass.trim() ? { pass: form.pass } : {}),
      from: form.from.trim() || null,
      secure: form.secure,
    })
      .then((r: TestEmailResult) => {
        setNotice(r.ok
          ? { kind: 'ok', text: `Test email sent to ${r.to} (${r.latencyMs}ms) — check your inbox.` }
          : { kind: 'err', text: `Test failed: ${r.error ?? 'unknown error'}` });
      })
      .catch(() => setNotice({ kind: 'err', text: 'Test failed — server unreachable.' }))
      .finally(() => setTesting(false));
  };

  return (
    <Section
      title="Invitation emails (SMTP)"
      description="Team invites are emailed through your SMTP provider (Gmail, OVH, Mailgun, Resend SMTP…). Leave empty to share invite links manually instead."
    >
      <div style={{
        marginBottom: 18, padding: '8px 12px', borderRadius: 'var(--radius-md)',
        fontSize: 12.5, fontWeight: 500, display: 'inline-block',
        background: statusPill.bg, color: statusPill.fg,
      }}>
        {statusPill.text}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 14, maxWidth: 560 }}>
        <div>
          <label style={labelStyle}>SMTP host</label>
          <input style={inputStyle} placeholder="smtp.gmail.com" value={form.host}
            onChange={e => set({ host: e.target.value })} />
        </div>
        <div>
          <label style={labelStyle}>Port</label>
          <input style={{ ...inputStyle, ...(portValid ? {} : { borderColor: 'var(--accent-red)' }) }}
            value={form.port} onChange={e => set({ port: e.target.value })} />
        </div>
        <div>
          <label style={labelStyle}>Username</label>
          <input style={inputStyle} placeholder="you@company.com" value={form.user}
            onChange={e => set({ user: e.target.value })} autoComplete="off" />
        </div>
        <div>
          <label style={labelStyle}>Password</label>
          <input style={inputStyle} type="password"
            placeholder={settings?.smtpPassSet ? '••••••••  (unchanged)' : 'app password'}
            value={form.pass} onChange={e => set({ pass: e.target.value })} autoComplete="new-password" />
        </div>
        <div>
          <label style={labelStyle}>From address</label>
          <input style={inputStyle} placeholder="norc@company.com (defaults to username)" value={form.from}
            onChange={e => set({ from: e.target.value })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 9 }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.secure} onChange={e => set({ secure: e.target.checked })} />
            Implicit TLS (port 465)
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center' }}>
        <button
          onClick={save}
          disabled={saving || !portValid}
          style={{ ...btnStyle, background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', opacity: saving || !portValid ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing || !form.host.trim()} style={{ ...btnStyle, opacity: testing || !form.host.trim() ? 0.6 : 1 }}>
          {testing ? 'Sending…' : 'Send test email to me'}
        </button>
        {notice && (
          <span style={{ fontSize: 13, color: notice.kind === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)' }}>
            {notice.text}
          </span>
        )}
      </div>
    </Section>
  );
}
