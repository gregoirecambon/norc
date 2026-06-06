export interface ProposedTask {
  id: string;
  title: string;
  url: string | null;
  kpis: string;
  createdTime: string | null;
}

export interface ScheduledTask {
  id: string;
  title: string;
  url: string | null;
  scheduledFor: string | null;
  recurrence: string;
  repeatEvery: number | null;
  status: string;
  assignees: string[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post(path: string): Promise<void> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
}

export const listProposedTasks = () => getJson<ProposedTask[]>('/api/tasks/proposed');
export const listScheduledTasks = () => getJson<ScheduledTask[]>('/api/tasks/scheduled');
export const approveTask = (id: string) => post(`/api/tasks/${id}/approve`);
export const dismissTask = (id: string) => post(`/api/tasks/${id}/dismiss`);
