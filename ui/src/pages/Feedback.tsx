import { useCallback, useEffect, useState } from 'react';
import { PageHeader, Section, btnStyle, inputStyle } from '../components/ui.js';
import { getSettings, saveSettings } from '../api/settings.js';
import {
  deleteInvite, deleteSubmission, getFeedbackStats, getInvites, getSubmissions, resendInvite,
  type FeedbackInvite, type FeedbackStats, type FeedbackSubmission,
} from '../api/feedback.js';

// Post-run human feedback: the enable/sampling/channel switchboard, the pending
// invite queue (copy link / resend / revoke), the submitted ratings, and the
// happiness aggregates (overall + per NORC tool).

const smallBtn: React.CSSProperties = { ...btnStyle, padding: '5px 11px', fontSize: 12.5 };
const dangerBtn: React.CSSProperties = { ...smallBtn, color: 'var(--accent-red)' };

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span style={{ fontSize: size, letterSpacing: 1, whiteSpace: 'nowrap' }} title={`${value.toFixed(1)} / 5`}>
      <span style={{ color: 'var(--accent-amber, #f5a623)' }}>{'★'.repeat(Math.round(value))}</span>
      <span style={{ color: 'var(--border)' }}>{'★'.repeat(5 - Math.round(value))}</span>
    </span>
  );
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function expiryLabel(expiresAt: number): string {
  const days = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
  return days <= 1 ? 'expires today' : `expires in ${days}d`;
}

function SettingsPanel() {
  const [enabled, setEnabled] = useState(false);
  const [rate, setRate] = useState(25);
  const [channel, setChannel] = useState<'slack' | 'email'>('slack');
  const [status, setStatus] = useState<'loading' | 'idle' | 'busy' | 'saved' | 'error'>('loading');

  useEffect(() => {
    getSettings().then(s => {
      setEnabled(s.feedbackEnabled);
      setRate(Math.round(s.feedbackSampleRate * 100));
      setChannel(s.feedbackChannel);
      setStatus('idle');
    }).catch(() => setStatus('error'));
  }, []);

  const save = () => {
    setStatus('busy');
    saveSettings({
      feedbackEnabled: enabled,
      feedbackSampleRate: Math.max(0, Math.min(100, rate)) / 100,
      feedbackChannel: channel,
    })
      .then(() => { setStatus('saved'); setTimeout(() => setStatus('idle'), 2000); })
      .catch(() => setStatus('error'));
  };

  return (
    <Section
      title="Feedback invites"
      description="After a task run finishes, NORC occasionally asks the human who triggered it how it went — a star rating, a comment, and up to 3 questions about the tools that run used. The form link lives 7 days, then self-destructs."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>Ask for feedback</span>
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>
              Sample finished work runs and invite the task creator to rate them.
            </span>
          </span>
        </label>

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              How often (% of finished runs)
            </label>
            <input
              type="number" min={0} max={100} value={rate}
              onChange={e => setRate(Number(e.target.value))}
              style={{ ...inputStyle, width: 110 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              Send via
            </label>
            <select value={channel} onChange={e => setChannel(e.target.value as 'slack' | 'email')} style={{ ...inputStyle, width: 160 }}>
              <option value="slack">Slack DM</option>
              <option value="email">Email</option>
            </select>
          </div>
          <button onClick={save} disabled={status === 'busy' || status === 'loading'} style={{ ...btnStyle, background: 'var(--primary)', color: 'var(--on-primary)', border: 'none' }}>
            {status === 'busy' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : 'Save'}
          </button>
          {status === 'error' && <span style={{ fontSize: 12.5, color: 'var(--accent-red)' }}>Couldn't save — try again.</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Slack DMs need the <code>im:write</code> and <code>users:read.email</code> scopes; email needs SMTP (Settings → Email).
          When neither can reach the human, the invite still appears below with a copyable link.
        </div>
      </div>
    </Section>
  );
}

function StatsPanel({ stats }: { stats: FeedbackStats | null }) {
  if (!stats || stats.overall.count === 0) {
    return (
      <Section title="Happiness" description="Aggregated from submitted feedback.">
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>No feedback yet — averages appear after the first submission.</div>
      </Section>
    );
  }
  const { avg, count, histogram } = stats.overall;
  const maxBar = Math.max(...histogram, 1);
  return (
    <Section title="Happiness" description="Aggregated from submitted feedback.">
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>
            {avg?.toFixed(1)}<span style={{ fontSize: 15, color: 'var(--text-dim)' }}> / 5</span>
          </div>
          <div style={{ marginTop: 6 }}><Stars value={avg ?? 0} size={16} /></div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{count} rating{count === 1 ? '' : 's'}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, justifyContent: 'center' }}>
          {[5, 4, 3, 2, 1].map(star => (
            <div key={star} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-dim)' }}>
              <span style={{ width: 14, textAlign: 'right' }}>{star}★</span>
              <div style={{ width: 140, height: 7, background: 'var(--surface1)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(histogram[star - 1]! / maxBar) * 100}%`, height: '100%', background: 'var(--primary)', borderRadius: 4 }} />
              </div>
              <span>{histogram[star - 1]}</span>
            </div>
          ))}
        </div>
        {stats.perTool.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
            {stats.perTool.map(t => (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ width: 110, color: 'var(--text-secondary)' }}>{t.label}</span>
                <Stars value={t.avg} />
                <span style={{ color: 'var(--text-dim)', fontSize: 11.5 }}>{t.avg.toFixed(1)} · {t.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

export default function FeedbackPage() {
  const [invites, setInvites] = useState<FeedbackInvite[]>([]);
  const [submissions, setSubmissions] = useState<FeedbackSubmission[]>([]);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resentId, setResentId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([getInvites(), getSubmissions(), getFeedbackStats()])
      .then(([i, s, st]) => { setInvites(i.invites); setSubmissions(s.submissions); setStats(st); setError(null); })
      .catch(err => setError(err instanceof Error ? err.message : 'failed'));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().then(refresh).catch(err => { setError(err instanceof Error ? err.message : 'failed'); refresh(); });
  };

  const copyLink = (invite: FeedbackInvite) => {
    void navigator.clipboard.writeText(invite.url).then(() => {
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const resend = (invite: FeedbackInvite) => {
    setError(null);
    resendInvite(invite.id)
      .then(() => { setResentId(invite.id); setTimeout(() => setResentId(null), 2000); refresh(); })
      .catch(err => setError(err instanceof Error ? err.message : 'failed'));
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <PageHeader title="Feedback" count={submissions.length} />

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--tint-rose)', color: 'var(--accent-red)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <SettingsPanel />
        <StatsPanel stats={stats} />

        <Section
          title={`Pending invites${invites.length ? ` (${invites.length})` : ''}`}
          description="Sent (or copy-link only) invites waiting for an answer. Links expire 7 days after they were minted."
        >
          {invites.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Nothing pending.</div>
          ) : invites.map(invite => (
            <div key={invite.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
              borderBottom: '1px solid var(--border)', fontSize: 13,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {invite.runTitle ?? 'Untitled run'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 1 }}>
                  {invite.recipientName ?? invite.recipient ?? 'no recipient'} · {invite.channel === 'slack' ? 'Slack DM' : 'email'}
                  {invite.sentAt === null && <span style={{ color: 'var(--accent-amber)' }}> · not delivered — copy the link</span>}
                  {' '}· {expiryLabel(invite.expiresAt)}
                </div>
              </div>
              {invite.agentName && (
                <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)', fontSize: 11.5, fontWeight: 600 }}>
                  {invite.agentName}
                </span>
              )}
              <button style={smallBtn} onClick={() => copyLink(invite)}>
                {copiedId === invite.id ? '✓ Copied' : 'Copy link'}
              </button>
              <button style={smallBtn} onClick={() => resend(invite)} disabled={!invite.recipient} title={invite.recipient ? undefined : 'No resolved recipient — use the link'}>
                {resentId === invite.id ? '✓ Sent' : 'Resend'}
              </button>
              <button style={dangerBtn} onClick={() => { if (window.confirm('Revoke this invite? The link stops working immediately.')) run(() => deleteInvite(invite.id)); }}>
                Revoke
              </button>
            </div>
          ))}
        </Section>

        <Section
          title={`Received feedback${submissions.length ? ` (${submissions.length})` : ''}`}
          description="What the humans said."
        >
          {submissions.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>No feedback received yet.</div>
          ) : submissions.map(sub => (
            <div key={sub.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Stars value={sub.rating} />
                <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sub.runTitle ?? 'Untitled run'}
                </span>
                {sub.agentName && (
                  <span style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)', fontSize: 11.5, fontWeight: 600 }}>
                    {sub.agentName}
                  </span>
                )}
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{fmtDate(sub.createdAt)}</span>
                <button style={dangerBtn} onClick={() => { if (window.confirm('Delete this feedback entry?')) run(() => deleteSubmission(sub.id)); }}>
                  Delete
                </button>
              </div>
              {sub.toolRatings.length > 0 && (
                <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                  {sub.toolRatings.map(t => (
                    <span key={t.key} style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {t.label} <Stars value={t.rating} size={11} />
                    </span>
                  ))}
                </div>
              )}
              {sub.comment && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  “{sub.comment}”
                </div>
              )}
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
