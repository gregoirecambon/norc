export interface FeedbackInvite {
  id: string;
  url: string;
  channel: 'slack' | 'email';
  recipient: string | null;
  recipientName: string | null;
  runTitle: string | null;
  agentName: string | null;
  runStatus: string | null;
  createdAt: number;
  expiresAt: number;
  sentAt: number | null;
}

export interface FeedbackToolRating {
  key: string;
  label: string;
  rating: number;
}

export interface FeedbackSubmission {
  id: string;
  runTitle: string | null;
  agentName: string | null;
  rating: number;
  comment: string | null;
  createdAt: number;
  toolRatings: FeedbackToolRating[];
}

export interface FeedbackStats {
  overall: { avg: number | null; count: number; histogram: number[] };
  perTool: { key: string; label: string; avg: number; count: number }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function mutate(path: string, method: 'POST' | 'DELETE'): Promise<void> {
  const res = await fetch(path, { method });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
}

export function getInvites(): Promise<{ invites: FeedbackInvite[] }> {
  return getJson('/api/feedback/invites');
}

export function resendInvite(id: string): Promise<void> {
  return mutate(`/api/feedback/invites/${id}/resend`, 'POST');
}

export function deleteInvite(id: string): Promise<void> {
  return mutate(`/api/feedback/invites/${id}`, 'DELETE');
}

export function getSubmissions(): Promise<{ submissions: FeedbackSubmission[] }> {
  return getJson('/api/feedback/submissions');
}

export function deleteSubmission(id: string): Promise<void> {
  return mutate(`/api/feedback/submissions/${id}`, 'DELETE');
}

export function getFeedbackStats(): Promise<FeedbackStats> {
  return getJson('/api/feedback/stats');
}
