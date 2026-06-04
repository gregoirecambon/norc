import { useEffect, useRef, useState } from 'react';

const MAX_LINES = 500;

interface ParsedLine {
  ts: string;
  agent: string;
  level: 'success' | 'error' | 'warn' | 'info';
  raw: string;
}

function parseLine(raw: string): ParsedLine {
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const agentMatch = raw.match(/\[([^\]]+)\]/);
  const agent = agentMatch?.[1] ?? 'NORC';
  const level =
    raw.includes('completed') || raw.includes('done') ? 'success'
    : raw.includes('failed') || raw.includes('error') ? 'error'
    : raw.includes('retry') || raw.includes('stale') ? 'warn'
    : 'info';
  return { ts, agent, level, raw };
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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onmessage = e => {
      setLines(prev => {
        const next = [...prev, parseLine(e.data as string)];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

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
        {lines.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-dim)' }}>
            {lines.length} events
          </span>
        )}
      </div>

      {/* Log rows */}
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
        {lines.map((l, i) => {
          const lv = LEVEL[l.level];
          return (
            <div key={i} style={{
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
                {l.agent}
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
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
