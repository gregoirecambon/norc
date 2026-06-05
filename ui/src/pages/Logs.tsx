import { useEffect, useRef, useState } from 'react';

const MAX_LINES = 2000;

interface ParsedLine {
  id: number;
  epoch: number;          // real timestamp (ms) for relative grouping
  ts: string;             // HH:MM:SS for display
  level: 'success' | 'error' | 'warn' | 'info';
  raw: string;
}

// Relative-time buckets, newest first. `max` is the upper age bound (ms).
const BUCKETS: { label: string; max: number }[] = [
  { label: 'Last 5 minutes', max: 5 * 60_000 },
  { label: '5–60 minutes ago', max: 60 * 60_000 },
  { label: '1–5 hours ago', max: 5 * 60 * 60_000 },
  { label: 'More than 5 hours ago', max: Infinity },
];

function bucketIndex(ageMs: number): number {
  const i = BUCKETS.findIndex(b => ageMs < b.max);
  return i < 0 ? BUCKETS.length - 1 : i;
}

function parseLine(epoch: number, raw: string, id: number): ParsedLine {
  // NORC log lines are "[norc HH:MM:SS] message". Prefer the embedded clock for
  // display; fall back to the epoch we received over the wire.
  const m = raw.match(/^\[norc (\d{2}:\d{2}:\d{2})\]\s*([\s\S]*)$/);
  const ts = m?.[1] ?? new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message = m?.[2] ?? raw;
  const level =
    message.includes('completed') || message.includes('done') || message.includes('replied') ? 'success'
    : message.includes('failed') || message.includes('error') || message.includes('rejected') ? 'error'
    : message.includes('ignored') || message.includes('discarded') || message.includes('retry') || message.includes('stale') ? 'warn'
    : 'info';
  return { id, epoch, ts, level, raw: message };
}

const LEVEL: Record<ParsedLine['level'], { dot: string; color: string }> = {
  success: { dot: '●', color: 'var(--accent-green)' },
  error:   { dot: '●', color: 'var(--accent-red)' },
  warn:    { dot: '●', color: 'var(--accent-amber)' },
  info:    { dot: '·', color: 'var(--text-dim)' },
};

export default function LogsPage() {
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const idRef = useRef(0);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.addEventListener('clear', () => setLines([]));
    es.onmessage = e => {
      let epoch = Date.now();
      let line = e.data as string;
      try {
        const parsed = JSON.parse(e.data as string) as { ts?: number; line?: string };
        if (typeof parsed.ts === 'number') epoch = parsed.ts;
        if (typeof parsed.line === 'string') line = parsed.line;
      } catch { /* fall back to raw string */ }
      setLines(prev => {
        const next = [...prev, parseLine(epoch, line, idRef.current++)];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  // Re-bucket periodically so relative labels stay current as logs age.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const handleClear = async () => {
    setLines([]); // optimistic
    try { await fetch('/api/logs', { method: 'DELETE' }); } catch { /* ignore */ }
  };

  // Group into buckets (newest bucket first); within each, newest line first.
  const grouped = BUCKETS.map(() => [] as ParsedLine[]);
  for (const l of lines) grouped[bucketIndex(now - l.epoch)]!.push(l);
  for (const g of grouped) g.reverse();

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 32px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: 0 }}>Logs</h1>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 10px', borderRadius: 4,
          background: connected ? 'var(--tint-mint)' : 'var(--surface1)',
          color: connected ? 'var(--tint-mint-text)' : 'var(--text-dim)',
          fontSize: 12, fontWeight: 600,
        }}>
          <span style={{ fontSize: 7 }}>{connected ? '●' : '○'}</span>
          {connected ? 'live' : 'connecting…'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {lines.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {lines.length} events · newest first
            </span>
          )}
          <button
            onClick={handleClear}
            disabled={lines.length === 0}
            title="Clear all logs (also wipes stored history)"
            style={{
              fontSize: 12, fontWeight: 600,
              padding: '5px 12px', borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface1)',
              color: lines.length === 0 ? 'var(--text-dim)' : 'var(--text-secondary)',
              cursor: lines.length === 0 ? 'default' : 'pointer',
              opacity: lines.length === 0 ? 0.5 : 1,
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log rows, grouped by relative time, newest first */}
      <div
        role="log"
        aria-live="polite"
        aria-label="NORC log stream"
        style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}
      >
        {lines.length === 0 && (
          <div style={{ padding: '64px 32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
            No events yet — agents will appear here when triggered.
          </div>
        )}

        {grouped.map((group, bi) => group.length === 0 ? null : (
          <div key={BUCKETS[bi]!.label}>
            <div style={{
              position: 'sticky', top: 0, zIndex: 1,
              padding: '6px 32px',
              background: 'var(--bg)', borderBottom: '1px solid var(--border)',
              fontSize: 11, fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              {BUCKETS[bi]!.label}
              <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>· {group.length}</span>
            </div>
            {group.map(l => {
              const lv = LEVEL[l.level];
              return (
                <div key={l.id} style={{
                  display: 'flex', alignItems: 'baseline', gap: 0,
                  padding: '2px 32px', borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ color: 'var(--text-dim)', minWidth: 72, fontSize: 11, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                    {l.ts}
                  </span>
                  <span style={{
                    fontSize: 11, padding: '1px 8px', borderRadius: 4,
                    background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)',
                    minWidth: 100, textAlign: 'center', flexShrink: 0, marginRight: 14,
                    fontFamily: 'var(--font-mono)', fontWeight: 500,
                  }}>
                    NORC
                  </span>
                  <span style={{ color: lv.color, fontFamily: 'var(--font-mono)', fontSize: 11, marginRight: 8, flexShrink: 0 }}>
                    {lv.dot}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: l.level === 'info' ? 'var(--text-primary)' : lv.color,
                    flex: 1, lineHeight: 1.6,
                  }}>
                    {l.raw}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
