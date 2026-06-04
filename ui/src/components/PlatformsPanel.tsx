import { useState, useEffect } from 'react';
import { listPlatforms, createPlatform, deletePlatform, grantPlatformAccess, revokePlatformAccess, type Platform } from '../api/platforms.js';
import type { AgentRow } from '../api/agents.js';

interface Props {
  agents: AgentRow[];
  embedded?: boolean;
}

export function PlatformsPanel({ agents, embedded }: Props) {
  const [open, setOpen] = useState(!!embedded);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', apiKey: '' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = () => {
    listPlatforms().then(setPlatforms).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) reload();
  }, [open]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.apiKey) { setFormError('Name and API key are required'); return; }
    setSaving(true);
    setFormError('');
    try {
      const p = await createPlatform({ name: form.name, description: form.description || undefined, apiKey: form.apiKey });
      setPlatforms(prev => [...prev, { ...p, hasApiKey: true, grantedAgentIds: [] }]);
      setForm({ name: '', description: '', apiKey: '' });
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: Platform) => {
    if (!window.confirm(`Delete platform "${p.name}"?`)) return;
    await deletePlatform(p.id);
    setPlatforms(prev => prev.filter(x => x.id !== p.id));
  };

  const toggleGrant = async (platformId: string, agentId: string, isGranted: boolean) => {
    if (isGranted) {
      await revokePlatformAccess(platformId, agentId);
      setPlatforms(prev => prev.map(p => p.id === platformId
        ? { ...p, grantedAgentIds: p.grantedAgentIds.filter(id => id !== agentId) }
        : p));
    } else {
      await grantPlatformAccess(platformId, agentId);
      setPlatforms(prev => prev.map(p => p.id === platformId
        ? { ...p, grantedAgentIds: [...p.grantedAgentIds, agentId] }
        : p));
    }
  };

  return (
    <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', padding: '10px 14px',
          background: 'var(--surface2)', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{open ? '▼' : '▶'}</span>
        Platforms
        {platforms.length > 0 && (
          <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-dim)', background: 'var(--surface1)', border: '1px solid var(--border)', borderRadius: 10, padding: '0px 7px' }}>
            {platforms.length}
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: 14, background: 'var(--surface1)' }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            Platforms are external services agents can be granted access to. Once approved, an agent can retrieve the API key via <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>GET /api/me/platforms</code>.
          </p>

          {loading ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>
          ) : (
            <>
              {platforms.length === 0 && !showForm && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>No platforms yet.</div>
              )}

              {platforms.map(p => (
                <div key={p.id} style={{ marginBottom: 12, padding: 10, background: 'var(--surface2)', borderRadius: 5, border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                    {p.description && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{p.description}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-green)' }}>● key set</span>
                    <button
                      onClick={() => handleDelete(p)}
                      style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer' }}
                    >
                      ×
                    </button>
                  </div>

                  {agents.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No agents registered yet.</div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {agents.map(a => {
                        const granted = p.grantedAgentIds.includes(a.id);
                        return (
                          <button
                            key={a.id}
                            onClick={() => toggleGrant(p.id, a.id, granted)}
                            style={{
                              fontSize: 11, padding: '2px 8px', borderRadius: 10,
                              border: `1px solid ${granted ? 'var(--accent-green)' : 'var(--border)'}`,
                              background: granted ? 'rgba(0,200,100,0.1)' : 'transparent',
                              color: granted ? 'var(--accent-green)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            {granted ? '✓ ' : ''}{a.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}

              {showForm ? (
                <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--surface2)', borderRadius: 5, border: '1px solid var(--border)' }}>
                  <input
                    placeholder="Platform name (e.g. Notion)"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    style={inputStyle}
                  />
                  <input
                    placeholder="Description (optional)"
                    value={form.description}
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    style={inputStyle}
                  />
                  <input
                    type="password"
                    placeholder="API key"
                    value={form.apiKey}
                    onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                    style={inputStyle}
                  />
                  {formError && <span style={{ fontSize: 11, color: 'var(--accent-red)' }}>{formError}</span>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" disabled={saving} style={btnStyle}>
                      {saving ? 'Saving…' : 'Add Platform'}
                    </button>
                    <button type="button" onClick={() => setShowForm(false)} style={{ ...btnStyle, background: 'transparent' }}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button onClick={() => setShowForm(true)} style={btnStyle}>+ Add Platform</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--surface1)',
  color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box',
};

const btnStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 12px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--surface2)',
  color: 'var(--text-primary)', cursor: 'pointer',
};
