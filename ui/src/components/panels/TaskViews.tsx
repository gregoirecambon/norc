import { useState, useEffect, useCallback } from 'react';
import {
  listProposedTasks, listScheduledTasks, approveTask, dismissTask,
  type ProposedTask, type ScheduledTask,
} from '../../api/tasks.js';
import { btnStyle } from '../ui.js';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h`
    : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

const card: React.CSSProperties = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
  padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
};
const titleLink: React.CSSProperties = { fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', textDecoration: 'none' };
const meta: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)' };
const badge: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
  background: 'var(--tint-sky)', color: 'var(--tint-sky-text)',
};

function Empty({ text }: { text: string }) {
  return <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '14px 2px' }}>{text}</div>;
}
function ErrLine({ text }: { text: string }) {
  return <div style={{ fontSize: 12.5, color: 'var(--accent-red)', padding: '8px 2px' }}>{text}</div>;
}

export function ProposalsList() {
  const [items, setItems] = useState<ProposedTask[] | null>(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setErr('');
    listProposedTasks().then(setItems).catch(e => { setItems([]); setErr(e instanceof Error ? e.message : 'Failed to load'); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, fn: (id: string) => Promise<void>) => {
    setBusyId(id); setErr('');
    try {
      await fn(id);
      setItems(prev => (prev ?? []).filter(t => t.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Proposed tasks{items ? ` (${items.length})` : ''}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}>Refresh</button>
      </div>
      {err && <ErrLine text={err} />}
      {items === null && <Empty text="Loading…" />}
      {items && items.length === 0 && <Empty text="No proposals — the co-CEO hasn't suggested anything yet." />}
      {items && items.map(t => (
        <div key={t.id} style={card}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <a href={t.url ?? '#'} target="_blank" rel="noreferrer" style={titleLink}>{t.title}</a>
            <div style={meta}>
              {t.kpis ? `${t.kpis} · ` : ''}proposed {relTime(t.createdTime)}
            </div>
          </div>
          <button onClick={() => act(t.id, approveTask)} disabled={busyId === t.id}
            style={{ ...btnStyle, padding: '6px 12px', background: 'var(--primary)', color: 'var(--on-primary)', border: 'none', cursor: busyId === t.id ? 'default' : 'pointer' }}>
            {busyId === t.id ? '…' : 'Approve'}
          </button>
          <button onClick={() => act(t.id, dismissTask)} disabled={busyId === t.id}
            style={{ ...btnStyle, padding: '6px 10px', cursor: busyId === t.id ? 'default' : 'pointer' }} title="Dismiss (archive)">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function ScheduledTasksList() {
  const [items, setItems] = useState<ScheduledTask[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setErr('');
    listScheduledTasks().then(setItems).catch(e => { setItems([]); setErr(e instanceof Error ? e.message : 'Failed to load'); });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Scheduled tasks{items ? ` (${items.length})` : ''}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={load} style={{ ...btnStyle, padding: '5px 10px', fontSize: 12 }}>Refresh</button>
      </div>
      {err && <ErrLine text={err} />}
      {items === null && <Empty text="Loading…" />}
      {items && items.length === 0 && <Empty text="No scheduled tasks. Set a “Scheduled For” date on a task in Notion." />}
      {items && items.map(t => {
        const recurring = t.recurrence && t.recurrence !== 'None';
        const recLabel = t.repeatEvery && t.repeatEvery > 0 ? `every ${t.repeatEvery}d` : t.recurrence;
        return (
          <div key={t.id} style={card}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a href={t.url ?? '#'} target="_blank" rel="noreferrer" style={titleLink}>{t.title}</a>
              <div style={meta}>
                next {relTime(t.scheduledFor)}
                {t.assignees.length ? ` · ${t.assignees.map(a => `@${a}`).join(', ')}` : ' · unassigned'}
                {t.status ? ` · ${t.status}` : ''}
              </div>
            </div>
            {recurring && <span style={badge}>{recLabel}</span>}
          </div>
        );
      })}
    </div>
  );
}
