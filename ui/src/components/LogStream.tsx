import { useEffect, useRef, useState } from 'react';

const MAX_LINES = 200;

export function LogStream() {
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = e => {
      // Stream payload is JSON { ts, line }; fall back to the raw string.
      let line = e.data as string;
      try {
        const parsed = JSON.parse(e.data as string) as { line?: string };
        if (typeof parsed.line === 'string') line = parsed.line;
      } catch { /* keep raw */ }
      setLines(prev => {
        const next = [...prev, line];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div style={{ marginTop: 24, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', background: 'var(--surface2)', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Live Log
      </div>
      <div style={{ height: 180, overflowY: 'auto', padding: 10, background: 'var(--bg)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
        {lines.length === 0
          ? <span style={{ color: 'var(--text-dim)' }}>Waiting for events…</span>
          : lines.map((line, i) => <div key={i}>{line}</div>)
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
