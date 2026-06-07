import { useEffect, useState } from 'react';
import { getInvitePreview, getProviders, loginStartUrl, type InvitePreview } from '../api/auth.js';

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

const ERROR_MESSAGES: Record<string, (email?: string) => string> = {
  not_invited: email =>
    `${email ?? 'This account'} isn't invited to this workspace. Ask an admin to invite ${email ?? 'you'}.`,
  access_denied: () =>
    'The provider denied access. If this OAuth app is in testing mode, add your account as a test user in its console.',
  state_mismatch: () =>
    'Sign-in session expired or started from a different URL. Try again from this page.',
  oauth_failed: () => 'Sign-in failed. Please try again.',
};

interface Providers { google: boolean; github: boolean; publicUrl: string | null }

export default function LoginPage() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ token: string; preview: InvitePreview } | null>(null);

  useEffect(() => {
    getProviders().then(setProviders).catch(() => setProviders({ google: false, github: false, publicUrl: null }));

    // Read ?auth_error= / ?invite= from the OAuth redirect, then clean the URL.
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) {
      const make = ERROR_MESSAGES[authError] ?? ERROR_MESSAGES['oauth_failed']!;
      setError(make(params.get('email') ?? undefined));
    }
    const inviteToken = params.get('invite');
    if (inviteToken) {
      getInvitePreview(inviteToken)
        .then(preview => setInvite({ token: inviteToken, preview }))
        .catch(() => setInvite({ token: inviteToken, preview: { valid: false } }));
    }
    if (authError || inviteToken) {
      // Keep the invite usable across the OAuth round-trip but drop the error.
      const clean = inviteToken ? `/?invite=${encodeURIComponent(inviteToken)}` : '/';
      window.history.replaceState(null, '', clean);
    }
  }, []);

  const providerBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
    width: '100%', padding: '10px 16px',
    fontSize: 14, fontWeight: 500,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border)',
    background: 'var(--surface1)', color: 'var(--text-primary)',
    cursor: 'pointer', textDecoration: 'none',
  };

  const none = providers && !providers.google && !providers.github;
  // Browsing from a non-canonical origin (e.g. localhost while NORC_PUBLIC_URL
  // is a tunnel): sign-in must complete on the canonical origin, so the
  // provider buttons link there absolutely and we surface a hint.
  const wrongOrigin = !!providers?.publicUrl
    && new URL(providers.publicUrl).origin !== window.location.origin;

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{
        width: 360, maxWidth: '100%',
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-card)',
        padding: '36px 32px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0,
      }}>
        <img src="/norc-logo.png" alt="NORC" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover' }} />
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', marginTop: 14 }}>
          Sign in to NORC
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 5, marginBottom: 24, textAlign: 'center' }}>
          Your AI agent operations hub
        </div>

        {invite && (
          <div style={{
            width: '100%', marginBottom: 16, padding: '10px 14px',
            borderRadius: 'var(--radius-md)', fontSize: 13, lineHeight: 1.5,
            background: invite.preview.valid ? 'var(--tint-lavender)' : 'var(--tint-peach)',
            color: 'var(--text-primary)',
          }}>
            {invite.preview.valid ? (
              <>You've been invited as <strong>{invite.preview.role}</strong>. Sign in with the account for <strong>{invite.preview.email}</strong>.</>
            ) : (
              <>This invite link is no longer valid — ask for a new one.</>
            )}
          </div>
        )}

        {error && (
          <div style={{
            width: '100%', marginBottom: 16, padding: '10px 14px',
            borderRadius: 'var(--radius-md)', fontSize: 13, lineHeight: 1.5,
            background: 'var(--tint-rose)', color: 'var(--accent-red)',
          }}>
            {error}
          </div>
        )}

        {wrongOrigin && (
          <div style={{
            width: '100%', marginBottom: 16, padding: '10px 14px',
            borderRadius: 'var(--radius-md)', fontSize: 13, lineHeight: 1.5,
            background: 'var(--tint-sky)', color: 'var(--tint-sky-text)',
          }}>
            Signing in will continue on <strong>{new URL(providers!.publicUrl!).host}</strong> — use that address to stay signed in here too.
          </div>
        )}

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {providers?.google && (
            <a href={loginStartUrl('google', providers.publicUrl, invite?.token)} style={providerBtn}>
              <GoogleIcon /> Continue with Google
            </a>
          )}
          {providers?.github && (
            <a href={loginStartUrl('github', providers.publicUrl, invite?.token)} style={providerBtn}>
              <GitHubIcon /> Continue with GitHub
            </a>
          )}
          {none && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.6 }}>
              No sign-in provider is configured.<br />
              Set <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>GOOGLE_CLIENT_ID</code> or{' '}
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>GITHUB_CLIENT_ID</code> in your .env.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
