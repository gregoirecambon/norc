import type { CSSProperties, ReactNode } from 'react';

// Shared building blocks used by Settings + Operations so styling stays consistent.

export const inputStyle: CSSProperties = {
  fontSize: 13, padding: '8px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)', width: '100%',
};

export const labelStyle: CSSProperties = {
  fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 4, display: 'block',
};

/** Uppercase micro-label used above form fields in modals/panels. */
export const microLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 11, fontWeight: 600, color: 'var(--text-dim)',
  textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5,
};

export const btnStyle: CSSProperties = {
  fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)', cursor: 'pointer',
};

/** A bordered card with a header (title + optional description) and a body. */
export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {description && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>{description}</div>
        )}
      </div>
      <div style={{ padding: '18px 22px' }}>{children}</div>
    </div>
  );
}

/** Page title row with an optional count badge and right-aligned actions. */
export function PageHeader({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.3px', margin: 0 }}>{title}</h1>
      {count != null && (
        <span style={{ padding: '2px 9px', borderRadius: 4, background: 'var(--tint-lavender)', color: 'var(--tint-lavender-text)', fontSize: 12, fontWeight: 600 }}>{count}</span>
      )}
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** Underline tab bar (matches the sidebar's active-primary treatment). */
export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, marginBottom: 22, borderBottom: '1px solid var(--border)' }}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              appearance: 'none', background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '9px 14px', fontSize: 13.5, fontWeight: on ? 600 : 500,
              color: on ? 'var(--primary)' : 'var(--text-secondary)',
              borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
