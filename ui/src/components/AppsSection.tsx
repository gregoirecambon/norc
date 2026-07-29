// "Apps" block on the AI Agents page — non-AI API clients (n8n, custom
// services…) that hold a static key to /api/ext. Create/rotate show the key
// once in a copy callout (same treatment as the team invite link); each row
// expands into its recent access trail.

import { useState } from 'react';
import {
  createApp, rotateAppKey, revokeApp, deleteApp, syncAppToNotion, appAccessLog,
  type AppRow, type AppScope, type AppAccessRow,
} from '../api/apps.js';
import { timeAgo } from '../lib/time.js';

const ALL_SCOPES: { key: AppScope; label: string; hint: string }[] = [
  { key: 'read', label: 'read', hint: 'dashboard, agents, stats, projects, tasks, events' },
  { key: 'tasks:write', label: 'tasks:write', hint: 'create tasks (lands as Proposed)' },
  { key: 'tasks:approve', label: 'tasks:approve', hint: 'approve/dismiss proposals + route directly' },
];

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px',
  borderBottom: '1px solid var(--border)',
};
const tdStyle: React.CSSProperties = {
  padding: '9px 12px', fontSize: 13, color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border)',
};
const smallBtn: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface1)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
};

export function AppsSection({ apps, onChanged, provisioned }: {
  apps: AppRow[];
  onChanged: (next: AppRow[] | ((prev: AppRow[]) => AppRow[])) => void;
  provisioned: boolean;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [keyNotice, setKeyNotice] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [access, setAccess] = useState<Record<string, AppAccessRow[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const copyKey = (key: string) => {
    void navigator.clipboard.writeText(key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const toggleAccess = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    setAccess(prev => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const rows = await appAccessLog(id);
      setAccess(prev => ({ ...prev, [id]: rows }));
    } catch {
      setAccess(prev => ({ ...prev, [id]: [] }));
    }
  };

  const doAction = async (id: string, action: 'rotate' | 'revoke' | 'delete' | 'sync') => {
    setBusy(id + action);
    setErr('');
    try {
      if (action === 'rotate') {
        const { key, ...row } = await rotateAppKey(id);
        onChanged(prev => prev.map(a => a.id === id ? row : a));
        setKeyNotice({ name: row.name, key });
      } else if (action === 'revoke') {
        const fresh = await revokeApp(id);
        onChanged(prev => prev.map(a => a.id === id ? fresh : a));
      } else if (action === 'delete') {
        if (!window.confirm('Delete this app? Its key stops working immediately and the access log is removed.')) return;
        await deleteApp(id);
        onChanged(prev => prev.filter(a => a.id !== id));
      } else {
        const { orgDbPageId } = await syncAppToNotion(id);
        onChanged(prev => prev.map(a => a.id === id ? { ...a, orgDbPageId } : a));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '32px 0 10px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
          Apps · API clients
        </div>
        <div style={{ flex: 1 }} />
        {err && <span style={{ fontSize: 12, color: 'var(--accent-red)' }}>{err}</span>}
        <button onClick={() => setShowAdd(true)} style={{ ...smallBtn, background: 'var(--surface2)' }}>
          + Add App
        </button>
      </div>

      {keyNotice && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 10,
          background: 'var(--tint-mint)', borderRadius: 'var(--radius-md)', fontSize: 13,
        }}>
          <span style={{ color: 'var(--tint-mint-text)', fontWeight: 600, flexShrink: 0 }}>
            Key for {keyNotice.name} — copy it now, it won't be shown again:
          </span>
          <code style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)',
          }}>
            {keyNotice.key}
          </code>
          <button onClick={() => copyKey(keyNotice.key)} style={{ ...smallBtn, flexShrink: 0, background: copied ? 'var(--tint-mint)' : 'var(--surface2)' }}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          <button onClick={() => setKeyNotice(null)} style={{ ...smallBtn, flexShrink: 0 }}>Dismiss</button>
        </div>
      )}

      {apps.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', padding: 20,
          fontSize: 13, color: 'var(--text-dim)',
        }}>
          No apps yet. An app is a non-AI client (n8n, a custom service, a script) that gets a static API key
          to create tasks and read NORC's state through <code style={{ fontFamily: 'var(--font-mono)' }}>/api/ext</code>.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--surface2)' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Key</th>
                <th style={thStyle}>Scopes</th>
                <th style={thStyle}>Last used</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {apps.map(a => (
                <AppRowView
                  key={a.id}
                  app={a}
                  busy={busy}
                  expanded={expanded === a.id}
                  accessRows={access[a.id]}
                  provisioned={provisioned}
                  onToggleAccess={() => void toggleAccess(a.id)}
                  onAction={action => void doAction(a.id, action)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddAppModal
          onClose={() => setShowAdd(false)}
          onCreated={(app, key) => {
            onChanged(prev => prev.some(x => x.id === app.id) ? prev : [...prev, app]);
            setKeyNotice({ name: app.name, key });
            setShowAdd(false);
          }}
        />
      )}
    </>
  );
}

function AppRowView({ app, busy, expanded, accessRows, provisioned, onToggleAccess, onAction }: {
  app: AppRow;
  busy: string | null;
  expanded: boolean;
  accessRows: AppAccessRow[] | undefined;
  provisioned: boolean;
  onToggleAccess: () => void;
  onAction: (action: 'rotate' | 'revoke' | 'delete' | 'sync') => void;
}) {
  const revoked = !!app.revokedAt;
  return (
    <>
      <tr>
        <td style={tdStyle}>
          <div style={{ fontWeight: 600 }}>{app.name}</div>
          {app.description && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{app.description}</div>}
        </td>
        <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {app.keyPrefix}…
        </td>
        <td style={tdStyle}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {app.scopes.map(s => (
              <span key={s} style={{
                padding: '2px 7px', borderRadius: 4, background: 'var(--tint-sky, var(--surface1))',
                color: 'var(--tint-sky-text, var(--text-dim))', fontSize: 11, fontWeight: 600,
              }}>
                {s}
              </span>
            ))}
          </div>
        </td>
        <td style={{ ...tdStyle, fontSize: 12, color: 'var(--text-dim)' }}>
          {app.lastUsedAt ? timeAgo(app.lastUsedAt) : 'never'}
        </td>
        <td style={tdStyle}>
          <span style={{
            padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: revoked ? '#fde8e8' : 'var(--tint-mint)',
            color: revoked ? 'var(--accent-red)' : 'var(--tint-mint-text)',
          }}>
            {revoked ? 'Revoked' : 'Active'}
          </span>
        </td>
        <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button style={smallBtn} onClick={onToggleAccess}>{expanded ? 'Hide log' : 'Access log'}</button>
            <button style={smallBtn} disabled={busy === app.id + 'rotate'} onClick={() => onAction('rotate')}>
              {revoked ? 'New key' : 'Rotate'}
            </button>
            {!revoked && (
              <button style={smallBtn} disabled={busy === app.id + 'revoke'} onClick={() => onAction('revoke')}>Revoke</button>
            )}
            {provisioned && !app.orgDbPageId && (
              <button style={smallBtn} disabled={busy === app.id + 'sync'} onClick={() => onAction('sync')}>Sync to Notion</button>
            )}
            <button
              style={{ ...smallBtn, color: 'var(--accent-red)' }}
              disabled={busy === app.id + 'delete'}
              onClick={() => onAction('delete')}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ ...tdStyle, background: 'var(--surface1)', padding: '10px 16px' }}>
            {!accessRows ? (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading…</span>
            ) : accessRows.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>No API calls recorded yet.</span>
            ) : (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, display: 'grid', gap: 3 }}>
                {accessRows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, color: 'var(--text-secondary)' }}>
                    <span style={{ width: 110, flexShrink: 0, color: 'var(--text-dim)' }}>{timeAgo(r.at)}</span>
                    <span style={{ width: 50, flexShrink: 0 }}>{r.method}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.path}</span>
                    <span style={{ color: r.status < 400 ? 'var(--tint-mint-text)' : 'var(--accent-red)' }}>{r.status}</span>
                    {r.ip && <span style={{ color: 'var(--text-dim)' }}>{r.ip}</span>}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AddAppModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (app: AppRow, key: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scopes, setScopes] = useState<AppScope[]>(['read', 'tasks:write']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const nameOk = /^[a-z0-9][a-z0-9_-]*$/i.test(name) && name.length >= 2;

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const created = await createApp({ name, description: description.trim() || undefined, scopes });
      const { key, ...row } = created;
      onCreated(row as AppRow, key);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--surface2)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: 480,
        padding: 24, boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Add App</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.5 }}>
          A non-AI API client (n8n, custom service, script). It gets a static key for the
          {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>/api/ext</code> endpoints — shown once after creation.
        </div>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          Name
        </label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="n8n-marketing"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', marginBottom: 12,
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--surface1)', color: 'var(--text-primary)', fontSize: 13,
          }}
        />

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          Description (optional)
        </label>
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this app does"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', marginBottom: 12,
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--surface1)', color: 'var(--text-primary)', fontSize: 13,
          }}
        />

        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          Scopes
        </label>
        <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
          {ALL_SCOPES.map(s => (
            <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={scopes.includes(s.key)}
                onChange={e => setScopes(prev => e.target.checked ? [...prev, s.key] : prev.filter(x => x !== s.key))}
              />
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.label}</code>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{s.hint}</span>
            </label>
          ))}
        </div>

        {err && <div style={{ fontSize: 12, color: 'var(--accent-red)', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
          <button
            onClick={() => void submit()}
            disabled={!nameOk || scopes.length === 0 || busy}
            style={{
              padding: '7px 16px', borderRadius: 'var(--radius-md)', border: 'none',
              background: 'var(--primary)', color: 'var(--on-primary)', fontSize: 13, fontWeight: 500,
              cursor: (!nameOk || scopes.length === 0 || busy) ? 'default' : 'pointer',
              opacity: (!nameOk || scopes.length === 0 || busy) ? 0.6 : 1,
            }}
          >
            {busy ? 'Creating…' : 'Create App'}
          </button>
        </div>
      </div>
    </div>
  );
}
