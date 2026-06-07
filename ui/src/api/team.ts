import type { Role } from './auth.js';

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: 'admin' | 'member';
  createdAt: number;
  expiresAt: number;
  expired: boolean;
}

export interface TeamData {
  members: TeamMember[];
  invites?: TeamInvite[];
  smtpConfigured: boolean;
}

export interface InviteResult {
  invite: TeamInvite;
  emailSent: boolean;
  emailError?: string;
  inviteUrl: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const getTeam = () => request<TeamData>('/api/team');

export const createInvite = (email: string, role: 'admin' | 'member') =>
  request<InviteResult>('/api/team/invites', { method: 'POST', ...json({ email, role }) });

export const resendInvite = (id: string) =>
  request<InviteResult>(`/api/team/invites/${id}/resend`, { method: 'POST' });

export const revokeInvite = (id: string) =>
  request<{ ok: boolean }>(`/api/team/invites/${id}`, { method: 'DELETE' });

export const updateMemberRole = (id: string, role: 'admin' | 'member') =>
  request<{ member: TeamMember }>(`/api/team/members/${id}`, { method: 'PATCH', ...json({ role }) });

export const removeMember = (id: string) =>
  request<{ ok: boolean }>(`/api/team/members/${id}`, { method: 'DELETE' });
