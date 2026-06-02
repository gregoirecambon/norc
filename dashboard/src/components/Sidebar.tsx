import React, { useEffect, useState } from 'react';

type Page = 'summary' | 'livefeed' | 'agents';

interface Props {
  currentPage: Page;
  onNavigate: (p: Page) => void;
}

const API = import.meta.env.VITE_NORC_API ?? 'http://localhost:3001';

export default function Sidebar({ currentPage, onNavigate }: Props) {
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API}/health`);
        setHealthy(r.ok);
      } catch { setHealthy(false); }
    };
    check();
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, []);

  const navItem = (id: Page, icon: string, label: string) => (
    <a
      key={id}
      href="#"
      aria-current={currentPage === id ? 'page' : undefined}
      onClick={(e) => { e.preventDefault(); onNavigate(id); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 20px',
        color: currentPage === id ? 'var(--text-primary)' : 'var(--text-secondary)',
        textDecoration: 'none',
        fontSize: 13,
        borderLeft: currentPage === id ? '2px solid var(--accent-green)' : '2px solid transparent',
        background: currentPage === id ? 'rgba(255,255,255,0.04)' : 'transparent',
        minHeight: 'var(--touch-target)',
      }}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      {label}
    </a>
  );

  const healthColor = healthy === null ? 'var(--text-dim)' : healthy ? 'var(--accent-green)' : 'var(--accent-red)';
  const healthLabel = healthy === null ? 'checking' : healthy ? 'healthy' : 'offline';

  return (
    <nav
      aria-label="Main navigation"
      style={{
        width: 200,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div style={{
        padding: '16px 20px',
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: '-0.3px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: healthColor, display: 'inline-block' }}
          title={`Engine ${healthLabel}`}
          aria-label={`Engine status: ${healthLabel}`}
        />
        NORC
      </div>

      {/* Nav links */}
      <div style={{ flex: 1, paddingTop: 8 }}>
        <div style={{ padding: '10px 20px 4px', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Monitor
        </div>
        {navItem('summary',  '⊞', 'Summary')}
        {navItem('livefeed', '⚡', 'Live Feed')}
        <div style={{ padding: '10px 20px 4px', fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Configure
        </div>
        {navItem('agents', '◈', 'Agents')}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 20px',
        borderTop: '1px solid var(--border)',
        fontSize: 11,
        color: 'var(--text-dim)',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>v0.1.0</span>
        <span style={{ color: healthColor }}>{healthLabel}</span>
      </div>
    </nav>
  );
}
