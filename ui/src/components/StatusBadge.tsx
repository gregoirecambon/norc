type Status = 'connected' | 'unreachable' | 'untested';

const CONFIG: Record<Status, { color: string; label: string }> = {
  connected:  { color: 'var(--accent-green)', label: 'Connected' },
  unreachable: { color: 'var(--accent-red)',  label: 'Unreachable' },
  untested:   { color: 'var(--text-dim)',     label: 'Never tested' },
};

export function StatusBadge({ status }: { status: Status }) {
  const { color, label } = CONFIG[status] ?? CONFIG.untested;
  return (
    <span style={{ color, whiteSpace: 'nowrap' }}>
      ● {label}
    </span>
  );
}
