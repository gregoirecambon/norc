// Slack connection setup — lives as a tab in Settings. Flow mirrors the
// Notion page: paste secrets → verify → status card, plus the app manifest
// and Request URL the user needs on api.slack.com.

import { useEffect, useState } from 'react';
import { Section, btnStyle, inputStyle, labelStyle } from '../ui.js';
import {
  getSlack, saveSlackConfig, testSlack, disconnectSlack,
  type SlackInfo, type SlackIntegration,
} from '../../api/slack.js';

export function SlackPanel() {
  const [info, setInfo] = useState<SlackInfo | null>(null);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [copied, setCopied] = useState<'url' | 'manifest' | null>(null);

  const reload = () => getSlack().then(setInfo).catch(() => setNotice({ kind: 'err', text: 'Could not load Slack settings.' }));
  useEffect(() => { void reload(); }, []);

  if (!info) return <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>;
  const integ: SlackIntegration = info.integration;

  const statusPill = (() => {
    if (integ.status === 'active' && integ.source === 'env') {
      return { text: 'Connected via SLACK_* env vars (saving here overrides them)', bg: 'var(--tint-sky)', fg: 'var(--tint-sky-text)' };
    }
    if (integ.status === 'active') {
      return { text: `Connected — ${integ.teamName ?? 'workspace'} as @${integ.botName ?? 'Norc'}`, bg: 'var(--tint-mint)', fg: 'var(--tint-mint-text)' };
    }
    if (integ.status === 'error') {
      return { text: 'Connection error — re-check the bot token', bg: 'var(--tint-coral, #fdecea)', fg: 'var(--accent-red)' };
    }
    return { text: 'Not connected', bg: 'var(--tint-graphite)', fg: 'var(--tint-graphite-text)' };
  })();

  const save = () => {
    if (saving) return;
    const patch: { botToken?: string; signingSecret?: string } = {};
    if (botToken.trim()) patch.botToken = botToken.trim();
    if (signingSecret.trim()) patch.signingSecret = signingSecret.trim();
    if (!patch.botToken && !patch.signingSecret) return;
    setSaving(true);
    setNotice(null);
    saveSlackConfig(patch)
      .then(() => {
        setBotToken('');
        setSigningSecret('');
        setNotice({ kind: 'ok', text: 'Saved — Slack connection verified.' });
        return reload();
      })
      .catch((err: Error) => setNotice({ kind: 'err', text: `Save failed: ${err.message}` }))
      .finally(() => setSaving(false));
  };

  const test = () => {
    if (testing) return;
    setTesting(true);
    setNotice(null);
    testSlack()
      .then(r => {
        setNotice(r.ok
          ? { kind: 'ok', text: `Connected to ${r.teamName} as @${r.botName} (${r.latencyMs}ms).` }
          : { kind: 'err', text: `Test failed: ${r.error ?? 'unknown error'}` });
        return reload();
      })
      .catch(() => setNotice({ kind: 'err', text: 'Test failed — server unreachable.' }))
      .finally(() => setTesting(false));
  };

  const disconnect = () => {
    if (!window.confirm('Disconnect Slack? Agents will no longer be reachable from Slack.')) return;
    disconnectSlack().then(reload).catch(() => setNotice({ kind: 'err', text: 'Disconnect failed.' }));
  };

  const copy = (what: 'url' | 'manifest', text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const manifestJson = JSON.stringify(info.manifest, null, 2);

  return (
    <>
      <Section
        title="Slack workspace"
        description="Connect a custom Slack app so you can tag NORC agents in Slack, chat with them in threads, and have task updates posted to project channels."
      >
        <div style={{
          marginBottom: 18, padding: '8px 12px', borderRadius: 'var(--radius-md)',
          fontSize: 12.5, fontWeight: 500, display: 'inline-block',
          background: statusPill.bg, color: statusPill.fg,
        }}>
          {statusPill.text}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, maxWidth: 640 }}>
          <div>
            <label style={labelStyle}>Bot token (xoxb-…)</label>
            <input style={inputStyle} type="password"
              placeholder={integ.botTokenSet ? '••••••••  (unchanged)' : 'xoxb-…'}
              value={botToken} onChange={e => setBotToken(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <label style={labelStyle}>Signing secret</label>
            <input style={inputStyle} type="password"
              placeholder={integ.signingSecretSet ? '••••••••  (unchanged)' : 'from Basic Information'}
              value={signingSecret} onChange={e => setSigningSecret(e.target.value)} autoComplete="new-password" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center' }}>
          <button
            onClick={save}
            disabled={saving || (!botToken.trim() && !signingSecret.trim())}
            style={{ ...btnStyle, background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', opacity: saving || (!botToken.trim() && !signingSecret.trim()) ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Save & verify'}
          </button>
          <button onClick={test} disabled={testing || !integ.botTokenSet} style={{ ...btnStyle, opacity: testing || !integ.botTokenSet ? 0.6 : 1 }}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {integ.botTokenSet && integ.source === 'settings' && (
            <button onClick={disconnect} style={{ ...btnStyle, color: 'var(--accent-red)' }}>Disconnect</button>
          )}
          {notice && (
            <span style={{ fontSize: 13, color: notice.kind === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {notice.text}
            </span>
          )}
        </div>
      </Section>

      <Section
        title="Create the Slack app"
        description="On api.slack.com/apps choose “Create New App → From a manifest”, paste the manifest below, then install the app to your workspace and copy its bot token + signing secret here."
      >
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Events Request URL (pre-filled in the manifest)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', background: 'var(--bg-subtle, var(--tint-graphite))', padding: '7px 10px', borderRadius: 'var(--radius-md)', flex: 'none' }}>
              {info.webhookUrl}
            </code>
            <button onClick={() => copy('url', info.webhookUrl)} style={btnStyle}>
              {copied === 'url' ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>App manifest</label>
            <button onClick={() => copy('manifest', manifestJson)} style={btnStyle}>
              {copied === 'manifest' ? 'Copied ✓' : 'Copy manifest'}
            </button>
          </div>
          <pre style={{
            fontSize: 11.5, fontFamily: 'var(--font-mono)', background: 'var(--bg-subtle, var(--tint-graphite))',
            padding: 12, borderRadius: 'var(--radius-md)', maxHeight: 260, overflow: 'auto', margin: 0,
          }}>{manifestJson}</pre>
        </div>

        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <strong>After installing:</strong> invite the bot to the channels where agents should listen and post
          (<code style={{ fontFamily: 'var(--font-mono)' }}>/invite @Norc</code>). Subteam mentions only reach NORC in channels the bot is a member of.
          Per-agent <code style={{ fontFamily: 'var(--font-mono)' }}>@handles</code> use Slack user groups, which require a paid plan — on free plans, tag agents with
          <code style={{ fontFamily: 'var(--font-mono)' }}> @Norc AgentName …</code> instead.
        </div>
      </Section>
    </>
  );
}
