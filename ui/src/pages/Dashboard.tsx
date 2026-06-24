import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { getDashboard, type DashboardData, type DashboardRun, type RunStatus } from '../api/dashboard.js';
import { listProposedTasks, listScheduledTasks, type ProposedTask, type ScheduledTask } from '../api/tasks.js';
import { PageHeader, Section } from '../components/ui.js';
import { timeAgo } from '../lib/time.js';

const RUN_STATUS: Record<RunStatus, { bg: string; color: string; label: string }> = {
  in_flight: { bg: 'var(--tint-sky)',   color: 'var(--tint-sky-text)',   label: 'Running' },
  done:      { bg: 'var(--tint-mint)',  color: 'var(--tint-mint-text)',  label: 'Done' },
  failed:    { bg: '#fde8e8',           color: 'var(--accent-red)',      label: 'Failed' },
  timed_out: { bg: 'var(--tint-peach)', color: 'var(--tint-peach-text)', label: 'Timed out' },
};

const cardStyle: CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: '16px 20px',
};

function StatCard({ value, label, accent }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 26, fontWeight: 600, color: accent ? 'var(--accent-green)' : 'var(--text-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 4, fontSize: 12, fontWeight: 600,
      background: s.bg, color: s.color, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  );
}

function RunTitle({ run }: { run: DashboardRun }) {
  if (run.title) {
    return (
      <span style={{
        color: 'var(--text-secondary)', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {run.title}
      </span>
    );
  }
  return (
    <span style={{
      padding: '1px 7px', borderRadius: 4, fontSize: 11.5, fontWeight: 500,
      background: 'var(--surface1)', color: 'var(--text-dim)',
    }}>
      {run.anchorKind}
    </span>
  );
}

// A labelled command line with a one-click copy button.
function CopyRow({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(command).then(
    () => { setCopied(true); setTimeout(() => setCopied(false), 1200); },
    () => {},
  );
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--surface1)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{command}</code>
        <button onClick={copy} style={{ flexShrink: 0, padding: '0 14px', borderRadius: 6, border: 'none', background: copied ? 'var(--tint-mint)' : 'var(--primary)', color: copied ? 'var(--tint-mint-text)' : 'var(--on-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

// Popup with the exact steps to resume a remote Claude Code session on its machine.
function ResumeModal({ run, onClose }: { run: DashboardRun; onClose: () => void }) {
  const r = run.resume!;
  const sshCmd = r.sshHost ? `ssh ${r.sshHost}` : 'ssh <your-user>@<your-host>';
  const resumeCmd = `cd ${r.cwd} && claude --resume ${r.sessionId}`;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: 560, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Resume this Claude Code session</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, color: 'var(--text-dim)', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 18 }}>
          <p style={{ marginTop: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            This session lives on the worker machine. SSH onto it, then resume from the directory the task ran in — <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>claude --resume</code> only finds the session from that directory.
          </p>
          <CopyRow label="1 · SSH onto the machine" command={sshCmd} />
          <CopyRow label="2 · Resume the session" command={resumeCmd} />
        </div>
      </div>
    </div>
  );
}

// Session id (copyable) + optional deep-link into the agent's own tool. Debug aid
// on the active-run view: the id is shown for any adapter that has one, and becomes
// an "open session" link only when the agent is configured with a console URL.
function SessionId({ run }: { run: DashboardRun }) {
  const [copied, setCopied] = useState(false);
  const [showResume, setShowResume] = useState(false);
  if (!run.sessionId) return null;
  const sessionId = run.sessionId;
  const copy = () => {
    navigator.clipboard?.writeText(sessionId).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1000); },
      () => { /* clipboard blocked — leave the title showing the full id */ },
    );
  };
  const pillBase: CSSProperties = {
    flexShrink: 0, fontSize: 11, whiteSpace: 'nowrap',
    padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)',
    background: 'var(--surface1)',
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span
        onClick={copy}
        title={copied ? 'Copied!' : `Session ${sessionId} — click to copy`}
        style={{
          ...pillBase, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)',
          cursor: 'pointer', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {copied ? 'copied ✓' : sessionId}
      </span>
      {run.resume ? (
        <button
          onClick={() => setShowResume(true)}
          title="Show how to resume this session on the worker machine"
          style={{ ...pillBase, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          resume ↗
        </button>
      ) : run.sessionUrl ? (
        <a
          href={run.sessionUrl} target="_blank" rel="noreferrer"
          title="Open this session in the agent's tool"
          style={{ ...pillBase, fontWeight: 600, color: 'var(--text-secondary)', textDecoration: 'none' }}
        >
          open session ↗
        </a>
      ) : null}
      {showResume && run.resume && <ResumeModal run={run} onClose={() => setShowResume(false)} />}
    </span>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '8px 0', borderBottom: '1px solid var(--border)',
  fontSize: 13.5,
};

const emptyStyle: CSSProperties = { fontSize: 13, color: 'var(--text-dim)' };

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledTask[] | null>(null);
  const [proposed, setProposed] = useState<ProposedTask[] | null>(null);

  // Snapshot + Notion-backed counts (the latter run once: slow/rate-limited,
  // and a 400 simply means the workspace isn't provisioned yet → show "—").
  useEffect(() => {
    getDashboard().then(setData).catch(() => setData(null));
    listScheduledTasks().then(setScheduled).catch(() => setScheduled(null));
    listProposedTasks().then(setProposed).catch(() => setProposed(null));
  }, []);

  // Live: refetch the (pure SQLite) snapshot on run events, with a 30s polling
  // fallback since the event bus is in-memory.
  useEffect(() => {
    const refresh = () => { getDashboard().then(setData).catch(() => { /* keep last */ }); };
    const es = new EventSource('/api/events/stream');
    es.addEventListener('run.started', refresh);
    es.addEventListener('run.finished', refresh);
    es.addEventListener('queue.updated', refresh);
    const t = setInterval(refresh, 30_000);
    return () => { es.close(); clearInterval(t); };
  }, []);

  const stats = data?.stats;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <PageHeader title="Dashboard" />

        {/* Stat row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard value={stats?.activeRuns ?? '—'} label="Active runs" accent={(stats?.activeRuns ?? 0) > 0} />
          <StatCard value={stats?.queuedItems ?? '—'} label="Queued" />
          <StatCard value={stats ? `${stats.agentsConnected} / ${stats.agentsTotal}` : '—'} label="Agents connected" />
          <StatCard value={scheduled?.length ?? '—'} label="Scheduled tasks" />
          <StatCard value={proposed?.length ?? '—'} label="Pending proposals" />
        </div>

        {/* Active runs */}
        <Section title="Active runs" description="Agents working right now.">
          {!data || data.activeRuns.length === 0 ? (
            <div style={emptyStyle}>No agents working right now.</div>
          ) : (
            data.activeRuns.map((run, i) => (
              <div key={run.id} style={{ ...rowStyle, borderBottom: i === data.activeRuns.length - 1 ? 'none' : rowStyle.borderBottom }}>
                <span className="pulse-dot" />
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{run.agentName}</span>
                <RunTitle run={run} />
                <span style={{ flex: 1 }} />
                <SessionId run={run} />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  started {timeAgo(run.createdAt)}
                </span>
              </div>
            ))
          )}
        </Section>

        {/* Queued — work waiting for agent capacity (hidden when empty) */}
        {data && data.queued.length > 0 && (
          <Section title="Queued" description="Work waiting for an agent slot — runs as soon as capacity frees up.">
            {data.queued.map((item, i) => {
              // The server returns drain order (priority desc, then FIFO) — the
              // item's index among its agent's items IS its queue position.
              const position = data.queued.filter((q, j) => q.agentId === item.agentId && j <= i).length;
              return (
                <div key={item.id} style={{ ...rowStyle, borderBottom: i === data.queued.length - 1 ? 'none' : rowStyle.borderBottom }}>
                  <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{item.agentName}</span>
                  {item.title ? (
                    <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title}
                    </span>
                  ) : (
                    <span style={{ padding: '1px 7px', borderRadius: 4, fontSize: 11.5, fontWeight: 500, background: 'var(--surface1)', color: 'var(--text-dim)' }}>
                      {item.anchorKind}
                    </span>
                  )}
                  <span style={{
                    padding: '1px 7px', borderRadius: 4, fontSize: 11.5, fontWeight: 500,
                    background: 'var(--tint-peach)', color: 'var(--tint-peach-text)', whiteSpace: 'nowrap',
                  }}>
                    #{position} in queue
                  </span>
                  {item.priority > 0 && (
                    <span style={{
                      padding: '1px 7px', borderRadius: 4, fontSize: 11.5, fontWeight: 500,
                      background: 'var(--tint-rose)', color: 'var(--tint-rose-text)', whiteSpace: 'nowrap',
                    }}>
                      priority
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    queued {timeAgo(item.enqueuedAt)}
                  </span>
                </div>
              );
            })}
          </Section>
        )}

        {/* Recent runs */}
        <Section title="Recent runs" description="Last 20 completed dispatches.">
          {!data || data.recentRuns.length === 0 ? (
            <div style={emptyStyle}>No runs yet.</div>
          ) : (
            data.recentRuns.map((run, i) => (
              <div key={run.id} style={{ ...rowStyle, borderBottom: i === data.recentRuns.length - 1 ? 'none' : rowStyle.borderBottom }}>
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{run.agentName}</span>
                <RunTitle run={run} />
                <span style={{ flex: 1 }} />
                <SessionId run={run} />
                <StatusPill status={run.status} />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', minWidth: 70, textAlign: 'right' }}>
                  {timeAgo(run.completedAt)}
                </span>
              </div>
            ))
          )}
        </Section>

        {/* Upcoming scheduled — only when the Notion workspace answers */}
        {scheduled !== null && scheduled.length > 0 && (
          <Section title="Upcoming scheduled" description="Next scheduled or recurring tasks.">
            {scheduled.slice(0, 5).map((task, i, arr) => (
              <div key={task.id} style={{ ...rowStyle, borderBottom: i === arr.length - 1 ? 'none' : rowStyle.borderBottom }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                {task.recurrence && task.recurrence !== 'None' && (
                  <span style={{
                    padding: '1px 7px', borderRadius: 4, fontSize: 11.5, fontWeight: 500,
                    background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)', whiteSpace: 'nowrap',
                  }}>
                    {task.recurrence}
                  </span>
                )}
                {task.assignees.length > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    → {task.assignees.join(', ')}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  {task.scheduledFor ? new Date(task.scheduledFor).toLocaleString() : '—'}
                </span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
