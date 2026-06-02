import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Summary from './pages/Summary';
import LiveFeed from './pages/LiveFeed';
import Agents from './pages/Agents';

type Page = 'summary' | 'livefeed' | 'agents';

export default function App() {
  const [page, setPage] = useState<Page>('summary');

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar currentPage={page} onNavigate={setPage} />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {page === 'summary'  && <Summary />}
        {page === 'livefeed' && <LiveFeed />}
        {page === 'agents'   && <Agents />}
      </main>
    </div>
  );
}
