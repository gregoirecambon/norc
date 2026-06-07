// Minimal OAuth2 authorization-code clients for Google and GitHub — raw fetch,
// no SDK, matching the house style (see notion-client.ts). Both are
// confidential clients (we hold a client secret), so a CSRF `state` nonce is
// sufficient; PKCE is not required.

export type OAuthProvider = 'google' | 'github';

export interface OAuthIdentity {
  email: string;        // verified email, lowercased
  name: string | null;
  avatarUrl: string | null;
  subject: string;      // provider's stable user id
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function enabledProviders(): Record<OAuthProvider, boolean> {
  return {
    google: !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET')),
    github: !!(env('GITHUB_CLIENT_ID') && env('GITHUB_CLIENT_SECRET')),
  };
}

export function isProvider(p: string): p is OAuthProvider {
  return p === 'google' || p === 'github';
}

/**
 * Callback URL registered with the provider. Derived from NORC_PUBLIC_URL —
 * in dev that's the UI origin (localhost:3000) because the callback traverses
 * the Vite proxy; hitting :3001 directly would set the cookie on the wrong origin.
 */
export function redirectUri(provider: OAuthProvider): string {
  const base = (env('NORC_PUBLIC_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/auth/${provider}/callback`;
}

export function authorizeUrl(provider: OAuthProvider, state: string): string {
  if (provider === 'google') {
    const q = new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: env('GITHUB_CLIENT_ID'),
    redirect_uri: redirectUri('github'),
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${q}`;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || body['error']) {
    throw new Error(`token exchange failed: ${body['error_description'] ?? body['error'] ?? res.status}`);
  }
  return body;
}

async function getJson(url: string, accessToken: string, accept = 'application/json'): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: accept, 'User-Agent': 'norc' },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/** Exchange the authorization code and resolve a verified identity. Throws on any failure. */
export async function exchangeAndFetchIdentity(provider: OAuthProvider, code: string): Promise<OAuthIdentity> {
  if (provider === 'google') {
    const token = await postForm('https://oauth2.googleapis.com/token', {
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri('google'),
      grant_type: 'authorization_code',
      code,
    });
    const info = await getJson('https://openidconnect.googleapis.com/v1/userinfo', String(token['access_token'])) as {
      sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
    };
    if (!info.email || info.email_verified !== true) throw new Error('Google account has no verified email');
    return {
      email: info.email.toLowerCase(),
      name: info.name ?? null,
      avatarUrl: info.picture ?? null,
      subject: info.sub,
    };
  }

  const token = await postForm('https://github.com/login/oauth/access_token', {
    client_id: env('GITHUB_CLIENT_ID'),
    client_secret: env('GITHUB_CLIENT_SECRET'),
    redirect_uri: redirectUri('github'),
    code,
  });
  const accessToken = String(token['access_token']);
  const user = await getJson('https://api.github.com/user', accessToken) as {
    id: number; login: string; name?: string | null; avatar_url?: string; email?: string | null;
  };
  const emails = await getJson('https://api.github.com/user/emails', accessToken) as
    { email: string; primary: boolean; verified: boolean }[];
  const primary = emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified);
  if (!primary) throw new Error('GitHub account has no verified email');
  return {
    email: primary.email.toLowerCase(),
    name: user.name ?? user.login ?? null,
    avatarUrl: user.avatar_url ?? null,
    subject: String(user.id),
  };
}
