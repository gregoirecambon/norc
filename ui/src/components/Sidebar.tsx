import React, { useEffect, useState } from 'react';
import type { Page } from '../App.js';

interface Props {
  currentPage: Page;
  onNavigate: (p: Page) => void;
}

function AgentsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="7.5" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M2.5 13c0-2.761 2.239-5 5-5s5 2.239 5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function OperationsIcon() {
  // Sliders / control board
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M2 4.5h11M2 10.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <circle cx="5" cy="4.5" r="1.6" fill="var(--surface1)" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="10" cy="10.5" r="1.6" fill="var(--surface1)" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}

function DashboardIcon() {
  // 2x2 grid of rounded squares
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="2" y="2" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="8.5" y="2" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="2" y="8.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3"/>
      <rect x="8.5" y="8.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M2 4h11M2 7.5h8M2 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M2.93 2.93l1.06 1.06M11.01 11.01l1.06 1.06M2.93 12.07l1.06-1.06M11.01 3.99l1.06-1.06" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function NotionIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="2" y="2" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5 5h5M5 7.5h5M5 10h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

const HEALTH_URL = '/api/health';

export default function Sidebar({ currentPage, onNavigate }: Props) {
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try { setHealthy((await fetch(HEALTH_URL)).ok); }
      catch { setHealthy(false); }
    };
    check();
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, []);

  const healthDot = healthy === null ? 'var(--text-dim)' : healthy ? 'var(--accent-green)' : 'var(--accent-red)';
  const healthLabel = healthy === null ? 'checking' : healthy ? 'healthy' : 'offline';

  function NavItem({ id, Icon, label }: { id: Page; Icon: () => React.ReactElement; label: string }) {
    const active = currentPage === id;
    return (
      <a
        href="#"
        aria-current={active ? 'page' : undefined}
        onClick={e => { e.preventDefault(); onNavigate(id); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', margin: '1px 8px',
          borderRadius: 'var(--radius-sm)',
          color: active ? 'var(--primary)' : 'var(--text-secondary)',
          background: active ? 'var(--tint-lavender)' : 'transparent',
          textDecoration: 'none', fontSize: 14,
          fontWeight: active ? 500 : 400,
          transition: 'background 120ms, color 120ms',
        }}
        onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--surface1)'; }}
        onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <Icon />
        {label}
      </a>
    );
  }

  return (
    <nav style={{
      width: 240, flexShrink: 0,
      background: 'var(--bg)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Brand */}
      <div style={{
        padding: '13px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <img src="/norc-logo.png" alt="NORC" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>NORC</span>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, paddingTop: 10, paddingBottom: 10 }}>
        <div style={sectionLabel}>Workspace</div>
        <NavItem id="agents" Icon={AgentsIcon} label="AI Agents" />
        <NavItem id="operations" Icon={OperationsIcon} label="Operations" />

        <div style={{ ...sectionLabel, marginTop: 16 }}>Monitor</div>
        <NavItem id="dashboard" Icon={DashboardIcon} label="Dashboard" />
        <NavItem id="logs" Icon={LogsIcon} label="Logs" />

        <div style={{ ...sectionLabel, marginTop: 16 }}>Configure</div>
        <NavItem id="settings" Icon={SettingsIcon} label="Settings" />
        <NavItem id="notion" Icon={NotionIcon} label="Notion" />
      </div>

      {/* Footer */}
      <div style={{
        padding: '11px 18px', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 12, color: 'var(--text-dim)',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: healthDot, display: 'inline-block' }} />
          <span style={{ color: healthDot }}>{healthLabel}</span>
        </span>
        <span>v0.1</span>
      </div>
    </nav>
  );
}

const sectionLabel: React.CSSProperties = {
  padding: '6px 18px 3px',
  fontSize: 11, fontWeight: 600,
  color: 'var(--text-dim)',
  textTransform: 'uppercase', letterSpacing: '0.7px',
};
