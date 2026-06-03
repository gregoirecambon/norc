import { useRef, useState, useEffect } from 'react';
import { getInvite, type InviteData } from '../api/agents.js';

function useLocalStorage(key: string, defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [val, setVal] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? defaultValue; }
    catch { return defaultValue; }
  });
  const set = (v: boolean) => { setVal(v); localStorage.setItem(key, JSON.stringify(v)); };
  return [val, set];
}

interface Props {
  hasAgents: boolean;
}

export function InvitePanel({ hasAgents }: Props) {
  const [open, setOpen] = useLocalStorage('norc-invite-panel-open', true);
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (hasAgents) {
      const stored = localStorage.getItem('norc-invite-panel-open');
      if (stored === null) setOpen(false);
    }
  }, [hasAgents]);

  useEffect(() => {
    getInvite()
      .then(setInvite)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleCopy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      textareaRef.current?.select();
    }
  };

  return (
    <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', textAlign: 'left', padding: '10px 14px',
          background: 'var(--surface2)', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{open ? '▼' : '▶'}</span>
        Connect an Agent
      </button>

      {open && (
        <div style={{ padding: 14, background: 'var(--surface1)' }}>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
            Paste this into your agent's system prompt, CLAUDE.md, or persona file.
            The agent will self-register on first run. The token is one-time use — a new one is generated after each registration.
          </p>

          {loading ? (
            <div style={{ height: 120, background: 'var(--surface2)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              Loading…
            </div>
          ) : error ? (
            <div style={{ padding: 10, background: 'var(--surface2)', borderRadius: 4, color: 'var(--accent-red)', fontSize: 12 }}>
              Invite unavailable ({error})
            </div>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                readOnly
                value={invite?.prompt ?? ''}
                style={{
                  width: '100%', height: 180, fontFamily: 'var(--font-mono)', fontSize: 11,
                  background: 'var(--surface2)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 4, padding: 8,
                  resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  onClick={handleCopy}
                  disabled={!invite}
                  style={{
                    fontSize: 12, padding: '5px 12px', borderRadius: 4,
                    background: copied ? 'var(--accent-green)' : 'var(--surface2)',
                    border: '1px solid var(--border)',
                    color: copied ? '#000' : 'var(--text-primary)',
                    cursor: 'pointer', fontWeight: copied ? 600 : 400,
                  }}
                >
                  {copied ? 'Copied!' : 'Copy Prompt'}
                </button>
                {invite && (
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    Token: {invite.token.slice(0, 12)}… (one-time use)
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
