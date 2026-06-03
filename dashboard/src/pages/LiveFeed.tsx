import React, { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_NORC_API ?? '';

interface LogEntry {
  ts: string;
  agent: string;
  message: string;
  level: 'info' | 'success' | 'warn' | 'error';
}

function parseLogLine(raw: string): LogEntry {
  const ts = new Date().toLocaleTimeString();
  if (raw.includes('completed') || raw.includes('done')) {
    return { ts, agent: extractAgent(raw), message: raw, level: 'success' };
  }
  if (raw.includes('failed') || raw.includes('error')) {
    return { ts, agent: extractAgent(raw), message: raw, level: 'error' };
  }
  if (raw.includes('retry') || raw.includes('stale')) {
    return { ts, agent: extractAgent(raw), message: raw, level: 'warn' };
  }
  return { ts, agent: extractAgent(raw), message: raw, level: 'info' };
}

function extractAgent(line: string): string {
  const m = line.match(/\[([^\]]+)\]/);
  return m?.[1] ?? 'NORC';
}

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  success: 'var(--accent-green)',
  error: 'var(--accent-red)',
  warn: 'var(--accent-amber)',
  info: 'var(--text-secondary)',
};

export default function LiveFeed() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`${API}/api/logs/stream`);
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      const entry = parseLogLine(e.data);
      setEntries(prev => [...prev.slice(-500), entry]); // keep last 500 lines
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Live Feed</span>
        <span style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 10,
          background: connected ? 'rgba(74,222,128,0.1)' : 'rgba(255,255,255,0.05)',
          color: connected ? 'var(--accent-green)' : 'var(--text-dim)',
        }}>
          {connected ? '● live' : '○ connecting...'}
        </span>
      </div>

      {/* Log stream — aria-live for screen readers */}
      <div
        role="log"
        aria-live="polite"
        aria-label="NORC agent log stream"
        style={{
          flex: 1,
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.7,
          padding: '4px 0',
        }}
      >
        {entries.length === 0 && (
          <div style={{ padding: '40px 20px', color: 'var(--text-dim)', textAlign: 'center' }}>
            No events yet. Agents will appear here when triggered.
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            padding: '2px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.025)',
          }}>
            <span style={{ color: 'var(--text-dim)', minWidth: 60, fontSize: 11 }}>{e.ts}</span>
            <span style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(59,130,246,0.15)',
              color: '#93c5fd',
              minWidth: 90,
              textAlign: 'center',
              flexShrink: 0,
            }}>{e.agent}</span>
            <span style={{ color: LEVEL_COLOR[e.level], flex: 1 }}>{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
