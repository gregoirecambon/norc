import Agents from './pages/Agents.js';

export default function App() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)' }}>
      <header style={{ padding: '0 20px', height: 44, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--surface1)', flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 1, color: 'var(--text-primary)' }}>norc</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>v0.1</span>
      </header>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <Agents />
      </div>
    </div>
  );
}
