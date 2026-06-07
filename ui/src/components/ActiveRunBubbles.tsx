import { useEffect, useState } from 'react';
import { getDashboard, type DashboardRun } from '../api/dashboard.js';

// Floating bottom-right bubbles — one per in-flight run, so it's always visible
// when the AI team is working, whatever page you're on. Mounted once at the App
// root so the SSE connection survives page switches.
export default function ActiveRunBubbles() {
  const [runs, setRuns] = useState<DashboardRun[]>([]);

  // Seed on mount + 30s polling fallback (the event bus is in-memory: a server
  // restart or a dropped EventSource would otherwise leave stale bubbles).
  useEffect(() => {
    const refresh = () => {
      getDashboard().then(d => setRuns(d.activeRuns)).catch(() => { /* server away — keep last */ });
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  // Live updates: bubbles pop on dispatch, vanish on completion.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');

    es.addEventListener('run.started', (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as {
        id: string; agentId: string; agentName: string; title: string | null;
        anchorKind: string; pageId: string; createdAt: number;
      };
      setRuns(prev => prev.some(r => r.id === data.id) ? prev : [...prev, {
        ...data, taskPageId: null, status: 'in_flight', agentActed: false, completedAt: null,
      }]);
    });

    es.addEventListener('run.finished', (e: MessageEvent) => {
      const { id } = JSON.parse(e.data as string) as { id: string };
      setRuns(prev => prev.filter(r => r.id !== id));
    });

    return () => es.close();
  }, []);

  if (runs.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 900,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
      pointerEvents: 'none',
    }}>
      {runs.map(run => (
        <div
          key={run.id}
          title={run.title ?? run.anchorKind}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 14px', maxWidth: 320,
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            boxShadow: 'var(--shadow-card)',
            fontSize: 13, color: 'var(--text-primary)',
            pointerEvents: 'auto',
          }}
        >
          <span className="pulse-dot" />
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{run.agentName}</span>
          {run.title && (
            <span style={{
              color: 'var(--text-dim)', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {run.title}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
