import React, { useEffect, useState } from 'react';
import type { Page } from '../App.js';
import type { SessionUser } from '../api/auth.js';
import { getVersion, type VersionInfo } from '../api/version.js';

interface Props {
  currentPage: Page;
  onNavigate: (p: Page) => void;
  user: SessionUser;
  onLogout: () => void;
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

function ChoresIcon() {
  // A multi-step flow: linked nodes
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="3.5" cy="7.5" r="1.8" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="11.5" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="11.5" cy="11" r="1.8" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5.2 6.7 9.8 4.6M5.2 8.3 9.8 10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
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

function TeamIcon() {
  // Two people
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <circle cx="5.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M1.5 12.5c0-2.21 1.79-4 4-4s4 1.79 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M10 2.8a2 2 0 0 1 0 3.4M11.5 8.8c1.21.62 2 1.86 2 3.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none">
      <path d="M9.5 2H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M7 7.5h6.5M11 4.5l2.5 3-2.5 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
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

export default function Sidebar({ currentPage, onNavigate, user, onLogout }: Props) {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    const check = async () => {
      try { setHealthy((await fetch(HEALTH_URL)).ok); }
      catch { setHealthy(false); }
    };
    check();
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
    // The server re-checks GitHub every ~6h; refresh the badge hourly to pick that up.
    const t = setInterval(() => { getVersion().then(setVersion).catch(() => {}); }, 3600_000);
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
        <NavItem id="chores" Icon={ChoresIcon} label="Chores" />

        <div style={{ ...sectionLabel, marginTop: 16 }}>Monitor</div>
        <NavItem id="dashboard" Icon={DashboardIcon} label="Dashboard" />
        <NavItem id="logs" Icon={LogsIcon} label="Logs" />

        <div style={{ ...sectionLabel, marginTop: 16 }}>Configure</div>
        <NavItem id="team" Icon={TeamIcon} label="Team" />
        <NavItem id="settings" Icon={SettingsIcon} label="Settings" />
        <NavItem id="notion" Icon={NotionIcon} label="Notion" />
      </div>

      {/* Signed-in user */}
      <div style={{
        padding: '10px 16px', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 9,
      }}>
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <span style={{
            width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
            background: 'var(--tint-lavender)', color: 'var(--primary)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
          }}>
            {(user.name ?? user.email).slice(0, 1)}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.name ?? user.email}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'capitalize' }}>{user.role}</div>
        </div>
        <button
          onClick={onLogout}
          title="Sign out"
          style={{
            appearance: 'none', background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-dim)', padding: 4, borderRadius: 'var(--radius-sm)',
            display: 'inline-flex', alignItems: 'center',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--accent-red)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
        >
          <SignOutIcon />
        </button>
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
        {version?.updateAvailable ? (
          <a
            href={version.url ?? 'https://github.com/gregoirecambon/norc/releases'}
            target="_blank"
            rel="noreferrer"
            title={`${version.latest} is available — you're on v${version.current}. See the README for update steps.`}
            style={{ color: 'var(--accent-amber)', fontWeight: 600, textDecoration: 'none' }}
          >
            Update available →
          </a>
        ) : (
          <span>{version ? `v${version.current}` : ''}</span>
        )}
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
