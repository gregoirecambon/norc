export type Role = 'owner' | 'admin' | 'member';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
}

export interface InvitePreview {
  valid: boolean;
  email?: string;
  role?: Role;
  expiresAt?: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const getSession = () => getJson<{ user: SessionUser | null }>('/api/auth/session');
export const getProviders = () =>
  getJson<{ google: boolean; github: boolean; publicUrl: string | null }>('/api/auth/providers');
export const getInvitePreview = (token: string) =>
  getJson<InvitePreview>(`/api/auth/invite/${encodeURIComponent(token)}`);

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

/**
 * Full-page navigation target that starts the OAuth round-trip. Always built
 * on the canonical origin (publicUrl) when known — the CSRF state cookie must
 * live on the origin Google redirects back to, so starting from e.g.
 * localhost while NORC_PUBLIC_URL is a tunnel would otherwise fail.
 */
export function loginStartUrl(provider: 'google' | 'github', publicUrl?: string | null, inviteToken?: string): string {
  const q = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : '';
  return `${publicUrl ?? ''}/api/auth/${provider}/start${q}`;
}
