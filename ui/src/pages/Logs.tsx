import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { inputStyle } from '../components/ui';

// 3 days of replayed history can be sizeable — keep enough that the time-range
// filter can still surface the oldest days.
const MAX_LINES = 5000;

interface ParsedLine {
  id: number;
  epoch: number;          // real timestamp (ms) for relative grouping
  ts: string;             // HH:MM:SS for display
  tag: string;            // source: NORC | Triage | Schedule | Co-CEO | agent name
  level: 'success' | 'error' | 'warn' | 'info';
  raw: string;
}

// Relative-time buckets, newest first. `max` is the upper age bound (ms).
const BUCKETS: { label: string; max: number }[] = [
  { label: 'Last 5 minutes', max: 5 * 60_000 },
  { label: '5–60 minutes ago', max: 60 * 60_000 },
  { label: '1–5 hours ago', max: 5 * 60 * 60_000 },
  { label: '5–24 hours ago', max: 24 * 60 * 60_000 },
  { label: 'More than a day ago', max: Infinity },
];

function bucketIndex(ageMs: number): number {
  const i = BUCKETS.findIndex(b => ageMs < b.max);
  return i < 0 ? BUCKETS.length - 1 : i;
}

function parseLine(epoch: number, raw: string, id: number, tag?: string): ParsedLine {
  // NORC log lines are "[<tag> HH:MM:SS] message" (tag may contain spaces, e.g.
  // an agent name). Prefer the embedded clock for display; fall back to the
  // epoch we received over the wire. The structured `tag` from the SSE payload
  // wins; the prefix is only a fallback for pre-tag history.
  const m = raw.match(/^\[(.+?) (\d{2}:\d{2}:\d{2})\]\s*([\s\S]*)$/);
  const ts = m?.[2] ?? new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message = m?.[3] ?? raw;
  const prefixTag = m?.[1] === 'norc' ? 'NORC' : m?.[1];
  const level =
    message.includes('completed') || message.includes('done') || message.includes('replied') ? 'success'
    : message.includes('failed') || message.includes('error') || message.includes('rejected') ? 'error'
    : message.includes('ignored') || message.includes('discarded') || message.includes('retry') || message.includes('stale') ? 'warn'
    : 'info';
  return { id, epoch, ts, tag: tag || prefixTag || 'NORC', level, raw: message };
}

const LEVEL: Record<ParsedLine['level'], { dot: string; color: string }> = {
  success: { dot: '●', color: 'var(--accent-green)' },
  error:   { dot: '●', color: 'var(--accent-red)' },
  warn:    { dot: '●', color: 'var(--accent-amber)' },
  info:    { dot: '·', color: 'var(--text-dim)' },
};

// Tag badge colors: fixed tints for the system sources, and a dedicated agent
// palette so every agent gets its own color (assigned by alphabetical rank,
// distinct until the palette wraps).
type Tint = { bg: string; text: string };
const FIXED_TAGS = ['NORC', 'Triage', 'Schedule', 'Co-CEO', 'Notion'];
const FIXED_TINT: Record<string, Tint> = {
  'NORC':     { bg: 'var(--tint-lavender)', text: 'var(--tint-lavender-text)' },
  'Triage':   { bg: 'var(--tint-sky)',      text: 'var(--tint-sky-text)' },
  'Schedule': { bg: 'var(--tint-peach)',    text: 'var(--tint-peach-text)' },
  'Co-CEO':   { bg: 'var(--tint-mint)',     text: 'var(--tint-mint-text)' },
  'Notion':   { bg: 'var(--tint-graphite)', text: 'var(--tint-graphite-text)' },
};
const AGENT_TINTS: Tint[] = [
  { bg: 'var(--tint-rose)',       text: 'var(--tint-rose-text)' },
  { bg: 'var(--tint-teal)',       text: 'var(--tint-teal-text)' },
  { bg: 'var(--tint-gold)',       text: 'var(--tint-gold-text)' },
  { bg: 'var(--tint-periwinkle)', text: 'var(--tint-periwinkle-text)' },
  { bg: 'var(--tint-coral)',      text: 'var(--tint-coral-text)' },
  { bg: 'var(--tint-sage)',       text: 'var(--tint-sage-text)' },
];

// Quick time-range presets ('all' and 'custom' are handled separately).
const RANGE_PRESETS: { id: string; label: string; ms: number }[] = [
  { id: '5m',  label: 'Last 5 minutes',  ms: 5 * 60_000 },
  { id: '30m', label: 'Last 30 minutes', ms: 30 * 60_000 },
  { id: '1h',  label: 'Last hour',       ms: 60 * 60_000 },
  { id: '12h', label: 'Last 12 hours',   ms: 12 * 60 * 60_000 },
  { id: '24h', label: 'Last day',        ms: 24 * 60 * 60_000 },
];

const filterInput: CSSProperties = { ...inputStyle, width: 'auto', fontSize: 12, padding: '6px 9px' };

export default function LogsPage() {
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const idRef = useRef(0);

  // Filters: free-text search, source tag, and time range (preset or custom).
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [range, setRange] = useState('all'); // 'all' | preset id | 'custom'
  const [customFrom, setCustomFrom] = useState(''); // datetime-local values
  const [customTo, setCustomTo] = useState('');

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.addEventListener('clear', () => setLines([]));
    es.onmessage = e => {
      let epoch = Date.now();
      let line = e.data as string;
      let tag: string | undefined;
      try {
        const parsed = JSON.parse(e.data as string) as { ts?: number; line?: string; tag?: string };
        if (typeof parsed.ts === 'number') epoch = parsed.ts;
        if (typeof parsed.line === 'string') line = parsed.line;
        if (typeof parsed.tag === 'string') tag = parsed.tag;
      } catch { /* fall back to raw string */ }
      setLines(prev => {
        const next = [...prev, parseLine(epoch, line, idRef.current++, tag)];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  // Re-bucket periodically so relative labels (and range presets) stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const handleClear = async () => {
    setLines([]); // optimistic
    try { await fetch('/api/logs', { method: 'DELETE' }); } catch { /* ignore */ }
  };

  // Tag options actually present in the stream: system tags first, agents A→Z.
  const availableTags = useMemo(() => {
    const seen = new Set(lines.map(l => l.tag));
    const fixed = FIXED_TAGS.filter(t => seen.has(t));
    const agents = [...seen].filter(t => !FIXED_TAGS.includes(t)).sort((a, b) => a.localeCompare(b));
    return [...fixed, ...agents];
  }, [lines]);

  // One color per agent, walked through the agent palette in alphabetical order.
  const tintFor = useMemo(() => {
    const map = new Map<string, Tint>();
    availableTags
      .filter(t => !FIXED_TAGS.includes(t))
      .forEach((name, i) => map.set(name, AGENT_TINTS[i % AGENT_TINTS.length]!));
    return (tag: string): Tint => FIXED_TINT[tag] ?? map.get(tag) ?? AGENT_TINTS[0]!;
  }, [availableTags]);

  const filtersActive = query.trim() !== '' || tagFilter !== 'all' || range !== 'all';
  const resetFilters = () => { setQuery(''); setTagFilter('all'); setRange('all'); setCustomFrom(''); setCustomTo(''); };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const preset = RANGE_PRESETS.find(p => p.id === range);
    let fromMs = -Infinity;
    let toMs = Infinity;
    if (preset) fromMs = now - preset.ms;
    else if (range === 'custom') {
      const f = customFrom ? new Date(customFrom).getTime() : NaN;
      const t = customTo ? new Date(customTo).getTime() : NaN;
      if (!Number.isNaN(f)) fromMs = f;
      if (!Number.isNaN(t)) toMs = t;
    }
    return lines.filter(l =>
      (tagFilter === 'all' || l.tag === tagFilter) &&
      l.epoch >= fromMs && l.epoch <= toMs &&
      (!q || l.raw.toLowerCase().includes(q) || l.tag.toLowerCase().includes(q)),
    );
  }, [lines, query, tagFilter, range, customFrom, customTo, now]);

  // Group into buckets (newest bucket first); within each, newest line first.
  const grouped = BUCKETS.map(() => [] as ParsedLine[]);
  for (const l of visible) grouped[bucketIndex(now - l.epoch)]!.push(l);
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
              {filtersActive ? `${visible.length} of ${lines.length}` : lines.length} events · newest first
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

      {/* Filter bar: search inside messages, filter by source tag and time range */}
      <div style={{
        padding: '10px 32px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <input
          type="search"
          placeholder="Search logs…"
          aria-label="Search logs"
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ ...filterInput, flex: 1, minWidth: 160, maxWidth: 320 }}
        />
        <select
          aria-label="Filter by type"
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          style={filterInput}
        >
          <option value="all">All types</option>
          {availableTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          aria-label="Filter by time range"
          value={range}
          onChange={e => setRange(e.target.value)}
          style={filterInput}
        >
          <option value="all">All time</option>
          {RANGE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {range === 'custom' && (
          <>
            <input
              type="datetime-local"
              aria-label="From"
              title="From"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              style={filterInput}
            />
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>→</span>
            <input
              type="datetime-local"
              aria-label="To"
              title="To"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              style={filterInput}
            />
          </>
        )}
        {filtersActive && (
          <button
            onClick={resetFilters}
            style={{
              fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6,
              border: 'none', background: 'transparent', color: 'var(--accent-blue)', cursor: 'pointer',
            }}
          >
            Reset
          </button>
        )}
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

        {lines.length > 0 && visible.length === 0 && (
          <div style={{ padding: '64px 32px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
            No log entries match your filters.
            <div style={{ marginTop: 10 }}>
              <button
                onClick={resetFilters}
                style={{
                  fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'var(--surface1)',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >
                Clear filters
              </button>
            </div>
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
              const tint = tintFor(l.tag);
              return (
                <div key={l.id} style={{
                  display: 'flex', alignItems: 'baseline', gap: 0,
                  padding: '2px 32px', borderBottom: '1px solid var(--border)',
                }}>
                  <span style={{ color: 'var(--text-dim)', minWidth: 72, fontSize: 11, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                    {l.ts}
                  </span>
                  <span title={l.tag} style={{
                    fontSize: 11, padding: '1px 8px', borderRadius: 4,
                    background: tint.bg, color: tint.text,
                    minWidth: 100, maxWidth: 140, textAlign: 'center', flexShrink: 0, marginRight: 14,
                    fontFamily: 'var(--font-mono)', fontWeight: 500,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {l.tag}
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
