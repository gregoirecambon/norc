import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../api/auth.js';
import {
  createInvite, getTeam, removeMember, resendInvite, revokeInvite, updateMemberRole,
  type TeamData, type TeamInvite, type TeamMember,
} from '../api/team.js';
import { PageHeader, Section, btnStyle, inputStyle } from '../components/ui.js';

const ROLE_BADGE: Record<string, { bg: string; fg: string }> = {
  owner:  { bg: 'var(--tint-gold)',     fg: 'var(--tint-gold-text)' },
  admin:  { bg: 'var(--tint-lavender)', fg: 'var(--tint-lavender-text)' },
  member: { bg: 'var(--tint-graphite)', fg: 'var(--tint-graphite-text)' },
};

function RoleBadge({ role }: { role: string }) {
  const c = ROLE_BADGE[role] ?? ROLE_BADGE['member']!;
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 4, fontSize: 12, fontWeight: 600,
      background: c.bg, color: c.fg, textTransform: 'capitalize',
    }}>
      {role}
    </span>
  );
}

function Avatar({ member }: { member: TeamMember }) {
  if (member.avatarUrl) {
    return <img src={member.avatarUrl} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <span style={{
      width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
      background: 'var(--tint-lavender)', color: 'var(--primary)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 600, textTransform: 'uppercase',
    }}>
      {(member.name ?? member.email).slice(0, 1)}
    </span>
  );
}

const smallBtn: React.CSSProperties = { ...btnStyle, padding: '5px 11px', fontSize: 12.5 };
const dangerBtn: React.CSSProperties = { ...smallBtn, color: 'var(--accent-red)' };

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function expiryLabel(invite: TeamInvite): string {
  if (invite.expired) return 'expired';
  const days = Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 86_400_000));
  return days <= 1 ? 'expires today' : `expires in ${days}d`;
}

interface Props {
  user: SessionUser;
}

export default function TeamPage({ user }: Props) {
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Last created/resent invite whose link should be surfaced for copying.
  const [linkNotice, setLinkNotice] = useState<{ email: string; url: string; emailSent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [sending, setSending] = useState(false);

  const canManage = user.role === 'owner' || user.role === 'admin';
  const isOwner = user.role === 'owner';

  const refresh = useCallback(() => {
    getTeam().then(d => { setData(d); setError(null); }).catch(err => setError(err.message));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().then(refresh).catch(err => { setError(err instanceof Error ? err.message : 'failed'); refresh(); });
  };

  const submitInvite = () => {
    const email = inviteEmail.trim();
    if (!email || sending) return;
    setSending(true);
    setError(null);
    createInvite(email, inviteRole)
      .then(result => {
        setInviteEmail('');
        setInviteRole('member');
        setLinkNotice({ email, url: result.inviteUrl, emailSent: result.emailSent });
        setCopied(false);
        refresh();
      })
      .catch(err => setError(err instanceof Error ? err.message : 'failed'))
      .finally(() => setSending(false));
  };

  const copyLink = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const invites = (data?.invites ?? []).filter(i => !i.expired);
  const expiredInvites = (data?.invites ?? []).filter(i => i.expired);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <PageHeader title="Team" count={data?.members.length} />

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--tint-rose)', color: 'var(--accent-red)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {canManage && (
          <Section
            title="Invite someone"
            description={data?.smtpConfigured
              ? 'They’ll receive an email with a sign-in link. Invites expire after 7 days.'
              : 'Email isn’t set up (Settings → Email) — you’ll get a link to share manually. Invites expire after 7 days.'}
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                type="email"
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitInvite(); }}
                style={{ ...inputStyle, flex: 1 }}
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as 'admin' | 'member')}
                style={{ ...inputStyle, width: 120 }}
              >
                <option value="member">Member</option>
                {isOwner && <option value="admin">Admin</option>}
              </select>
              <button
                onClick={submitInvite}
                disabled={sending || !inviteEmail.trim()}
                style={{
                  ...btnStyle,
                  background: 'var(--primary)', color: 'var(--on-primary)', border: 'none',
                  opacity: sending || !inviteEmail.trim() ? 0.6 : 1,
                }}
              >
                {sending ? 'Inviting…' : 'Send invite'}
              </button>
            </div>

            {linkNotice && (
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 'var(--radius-md)',
                background: linkNotice.emailSent ? 'var(--tint-mint)' : 'var(--tint-peach)',
                fontSize: 13, lineHeight: 1.6,
              }}>
                {linkNotice.emailSent
                  ? <>Invite emailed to <strong>{linkNotice.email}</strong>. You can also share the link directly:</>
                  : <>Email not sent — share this link with <strong>{linkNotice.email}</strong>:</>}
                <div style={{ display: 'flex', gap: 8, marginTop: 7, alignItems: 'center' }}>
                  <code style={{
                    flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11.5,
                    padding: '6px 9px', borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface1)', border: '1px solid var(--border)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {linkNotice.url}
                  </code>
                  <button onClick={() => copyLink(linkNotice.url)} style={smallBtn}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </Section>
        )}

        {canManage && invites.length > 0 && (
          <Section title="Pending invites" description="Waiting for the invitee to sign in. Resending rotates the link.">
            {invites.map(invite => (
              <div key={invite.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0',
                borderBottom: '1px solid var(--border)',
              }}>
                <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-primary)' }}>{invite.email}</span>
                <RoleBadge role={invite.role} />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', width: 100, textAlign: 'right' }}>{expiryLabel(invite)}</span>
                <button
                  style={smallBtn}
                  onClick={() => {
                    setError(null);
                    resendInvite(invite.id)
                      .then(result => {
                        setLinkNotice({ email: invite.email, url: result.inviteUrl, emailSent: result.emailSent });
                        setCopied(false);
                        refresh();
                      })
                      .catch(err => setError(err instanceof Error ? err.message : 'failed'));
                  }}
                >
                  Resend
                </button>
                <button style={dangerBtn} onClick={() => run(() => revokeInvite(invite.id))}>Revoke</button>
              </div>
            ))}
            {expiredInvites.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', paddingTop: 10 }}>
                {expiredInvites.length} expired invite{expiredInvites.length > 1 ? 's' : ''} — resend or revoke:{' '}
                {expiredInvites.map(i => i.email).join(', ')}
              </div>
            )}
          </Section>
        )}

        <Section title="Members" description="Everyone with access to this NORC workspace.">
          {!data && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>}
          {data?.members.map(member => {
            const isSelf = member.id === user.id;
            const canChangeRole = isOwner && member.role !== 'owner';
            const canRemove = !isSelf && member.role !== 'owner'
              && (isOwner || (user.role === 'admin' && member.role === 'member'));
            return (
              <div key={member.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
                borderBottom: '1px solid var(--border)',
              }}>
                <Avatar member={member} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {member.name ?? member.email}{isSelf && <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> (you)</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {member.email} · joined {fmtDate(member.createdAt)}
                  </div>
                </div>
                {canChangeRole ? (
                  <select
                    value={member.role}
                    onChange={e => run(() => updateMemberRole(member.id, e.target.value as 'admin' | 'member'))}
                    style={{ ...inputStyle, width: 100, padding: '4px 8px', fontSize: 12.5 }}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <RoleBadge role={member.role} />
                )}
                {canRemove && (
                  <button
                    style={dangerBtn}
                    onClick={() => {
                      if (window.confirm(`Remove ${member.email} from the team? They'll be signed out immediately.`)) {
                        run(() => removeMember(member.id));
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </Section>
      </div>
    </div>
  );
}
