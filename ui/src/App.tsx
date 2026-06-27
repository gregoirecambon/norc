import { useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.js';
import ActiveRunBubbles from './components/ActiveRunBubbles.js';
import AgentsPage from './pages/Agents.js';
import OperationsPage from './pages/Operations.js';
import DashboardPage from './pages/Dashboard.js';
import LogsPage from './pages/Logs.js';
import SettingsPage from './pages/Settings.js';
import ChoresPage from './pages/Chores.js';
import NotionPage from './pages/Notion.js';
import TeamPage from './pages/Team.js';
import LoginPage from './pages/Login.js';
import { getSession, logout, type SessionUser } from './api/auth.js';

export type Page = 'agents' | 'operations' | 'chores' | 'dashboard' | 'logs' | 'team' | 'settings' | 'notion';

export default function App() {
  const [page, setPage] = useState<Page>('agents');
  // 'loading' until the first /api/auth/session resolves; null = signed out.
  const [user, setUser] = useState<SessionUser | null | 'loading'>('loading');

  const checkSession = useCallback(() => {
    getSession().then(({ user }) => setUser(user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    checkSession();
    // Re-check on focus so an expired/revoked session flips to the login screen.
    window.addEventListener('focus', checkSession);
    return () => window.removeEventListener('focus', checkSession);
  }, [checkSession]);

  if (user === 'loading') {
    return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        user={user}
        onLogout={() => { void logout().then(() => setUser(null)); }}
      />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--surface2)' }}>
        {page === 'agents'     && <AgentsPage />}
        {page === 'operations' && <OperationsPage />}
        {page === 'chores'     && <ChoresPage />}
        {page === 'dashboard'  && <DashboardPage />}
        {page === 'logs'       && <LogsPage />}
        {page === 'team'     && <TeamPage user={user} />}
        {page === 'settings' && <SettingsPage />}
        {page === 'notion'   && <NotionPage />}
      </main>
      {/* Root-level so its SSE connection survives page switches. */}
      <ActiveRunBubbles />
    </div>
  );
}
