type Status = 'connected' | 'unreachable' | 'untested';

const CONFIG: Record<Status, { bg: string; color: string; label: string }> = {
  connected:   { bg: 'var(--tint-mint)',    color: 'var(--tint-mint-text)',    label: 'Connected' },
  unreachable: { bg: '#fde8e8',             color: 'var(--accent-red)',        label: 'Unreachable' },
  untested:    { bg: 'var(--surface1)',     color: 'var(--text-dim)',          label: 'Untested' },
};

export function StatusBadge({ status }: { status: Status }) {
  const c = CONFIG[status] ?? CONFIG.untested;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px', borderRadius: 4,
      background: c.bg, color: c.color,
      fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {c.label}
    </span>
  );
}
