import { useEffect, useState } from 'react';
import { PageHeader, Section, btnStyle } from '../components/ui.js';
import { getChores, provisionChoresDb, type ChoreSummary } from '../api/chores.js';
import { getSettings, saveSettings } from '../api/settings.js';

// Read-only view of the chore.md process definitions NORC loaded from disk, plus
// the two feature switches (enable chores + the Notion-sync kill-switch).

const badge = (text: string, tint = 'var(--tint-lavender)', color = 'var(--tint-lavender-text)'): React.CSSProperties => ({
  padding: '2px 8px', borderRadius: 4, background: tint, color, fontSize: 11, fontWeight: 600,
});

function Toggle({ on, busy, onChange, label, hint }: {
  on: boolean; busy: boolean; onChange: (v: boolean) => void; label: string; hint: string;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: busy ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={on} disabled={busy} onChange={e => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 }}>{hint}</span>
      </span>
    </label>
  );
}

function ChoreCard({ chore }: { chore: ChoreSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 10, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          appearance: 'none', border: 'none', cursor: 'pointer', width: '100%', textAlign: 'left',
          background: 'var(--surface1)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10,
        }}
      >
        <span style={{ color: 'var(--text-dim)', fontSize: 11, width: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{chore.id}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chore.description}
        </span>
        <span style={badge(chore.trigger)}>{chore.trigger}</span>
        <span style={badge(chore.approval, chore.approval === 'auto' ? 'var(--tint-green, #e6f4ea)' : 'var(--tint-amber, #fdf0d5)', 'var(--text-secondary)')}>
          {chore.approval === 'auto' ? 'auto-run' : 'needs approval'}
        </span>
        {chore.syncState && (
          <span
            title="Notion sync state"
            style={badge(
              chore.syncState,
              chore.syncState === 'conflict' ? 'var(--tint-red, #fdecec)' : chore.syncState === 'synced' ? 'var(--tint-green, #e6f4ea)' : 'var(--surface1)',
              chore.syncState === 'conflict' ? 'var(--accent-red)' : 'var(--text-dim)',
            )}
          >
            {chore.syncState}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{chore.steps.length} step{chore.steps.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
          {chore.inputs.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Inputs: {chore.inputs.map(i => <code key={i} style={{ fontFamily: 'var(--font-mono)', marginRight: 6 }}>{`{${i}}`}</code>)}
              <span style={{ marginLeft: 8, color: 'var(--text-dim)' }}>· min confidence {chore.minConfidence}</span>
            </div>
          )}
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {chore.steps.map(s => (
              <li key={s.number} style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>
                  {s.title || s.needs}
                  {s.after.length > 0 && (
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: 'var(--text-dim)' }}>after step {s.after.join(', ')}</span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  <div><span style={{ color: 'var(--text-dim)' }}>needs:</span> {s.needs}</div>
                  <div><span style={{ color: 'var(--text-dim)' }}>do:</span> {s.do}</div>
                  {s.returns && <div><span style={{ color: 'var(--text-dim)' }}>returns:</span> {s.returns}</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export default function ChoresPage() {
  const [chores, setChores] = useState<ChoreSummary[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notionSync, setNotionSync] = useState(true);
  const [dbProvisioned, setDbProvisioned] = useState(false);
  const [dbUrl, setDbUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    getChores()
      .then(r => {
        setChores(r.chores); setEnabled(r.enabled); setNotionSync(r.notionSync);
        setDbProvisioned(r.choresDbProvisioned); setDbUrl(r.choresDbUrl); setError(null);
      })
      .catch(() => setError('Could not load chores.'));
  };
  useEffect(load, []);

  const provision = async () => {
    setProvisioning(true);
    try { await provisionChoresDb(); load(); }
    catch { setError('Could not provide the Chores database in Notion.'); }
    finally { setProvisioning(false); }
  };

  const patch = async (p: { choresEnabled?: boolean; choresNotionSync?: boolean }) => {
    setBusy(true);
    try {
      const s = await saveSettings(p);
      setEnabled(s.choresEnabled);
      setNotionSync(s.choresNotionSync);
    } catch {
      // Re-sync from the server on failure so the toggles reflect reality.
      getSettings().then(s => { setEnabled(s.choresEnabled); setNotionSync(s.choresNotionSync); }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <PageHeader title="Chores" count={chores?.length} />

      <Section
        title="Chore processes"
        description="A chore is a reusable multi-step process (chore.md) the Triage Agent can run across several agents. Authored on the server under chores/<name>/CHORE.md; mention /chore <id> in a task to force one."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Toggle
            on={enabled} busy={busy} onChange={v => patch({ choresEnabled: v })}
            label="Enable chores"
            hint="Let the Triage Agent match incoming tasks to a chore process (requires the Triage Agent to be configured)."
          />
          <Toggle
            on={notionSync} busy={busy} onChange={v => patch({ choresNotionSync: v })}
            label="Sync chores to Notion"
            hint="Mirror chore definitions into the Notion Chores database (two-way). Turn off to run chores purely from the server files on disk."
          />
          {notionSync && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 24 }}>
              {dbProvisioned ? (
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  Chores database ready
                  {dbUrl && <> — <a href={dbUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>open in Notion ↗</a></>}
                </span>
              ) : (
                <>
                  <button onClick={provision} disabled={provisioning} style={btnStyle}>
                    {provisioning ? 'Setting up…' : 'Add / upgrade Chores DB'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Renames the dormant Pipeline DB → Chores (or creates it).</span>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      {error && <div style={{ color: 'var(--accent-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {chores && chores.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 2px' }}>
          No chores found. Add one at <code style={{ fontFamily: 'var(--font-mono)' }}>chores/&lt;name&gt;/CHORE.md</code> on the server.
        </div>
      )}

      {chores && chores.map(c => <ChoreCard key={c.id} chore={c} />)}
    </div>
  );
}
