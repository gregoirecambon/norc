import { useState } from 'react';
import Sidebar from './components/Sidebar.js';
import ActiveRunBubbles from './components/ActiveRunBubbles.js';
import AgentsPage from './pages/Agents.js';
import OperationsPage from './pages/Operations.js';
import DashboardPage from './pages/Dashboard.js';
import LogsPage from './pages/Logs.js';
import SettingsPage from './pages/Settings.js';
import NotionPage from './pages/Notion.js';

export type Page = 'agents' | 'operations' | 'dashboard' | 'logs' | 'settings' | 'notion';

export default function App() {
  const [page, setPage] = useState<Page>('agents');

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar currentPage={page} onNavigate={setPage} />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--surface2)' }}>
        {page === 'agents'     && <AgentsPage />}
        {page === 'operations' && <OperationsPage />}
        {page === 'dashboard'  && <DashboardPage />}
        {page === 'logs'       && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'notion'   && <NotionPage />}
      </main>
      {/* Root-level so its SSE connection survives page switches. */}
      <ActiveRunBubbles />
    </div>
  );
}
