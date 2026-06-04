import { useRef, useState, useEffect } from 'react';
import { getInvite, type InviteData } from '../api/agents.js';

interface Props {
  hasAgents: boolean;
  embedded?: boolean;
}

export function InvitePanel({ embedded }: Props) {
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const content = (
    <>
      {loading ? (
        <div style={{
          height: 120, background: 'var(--surface1)', borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 13,
        }}>
          Generating…
        </div>
      ) : error ? (
        <div style={{
          padding: '12px 14px', background: '#fde8e8',
          borderRadius: 'var(--radius-sm)', color: 'var(--accent-red)', fontSize: 13, lineHeight: 1.5,
        }}>
          Invite unavailable — set <code>NORC_PUBLIC_URL</code> in your .env and restart the engine.
          <div style={{ opacity: 0.7, fontSize: 12, marginTop: 3 }}>({error})</div>
        </div>
      ) : (
        <>
          <textarea
            ref={textareaRef}
            readOnly
            value={invite?.prompt ?? ''}
            style={{
              width: '100%', height: 180,
              fontFamily: 'var(--font-mono)', fontSize: 12,
              background: 'var(--surface1)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '10px 12px', resize: 'vertical', lineHeight: 1.6,
              boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={handleCopy}
              disabled={!invite}
              style={{
                padding: '8px 18px', borderRadius: 'var(--radius-md)',
                border: 'none',
                background: copied ? 'var(--tint-mint)' : 'var(--primary)',
                color: copied ? 'var(--tint-mint-text)' : 'var(--on-primary)',
                fontSize: 14, fontWeight: 500, cursor: 'pointer',
                transition: 'all 150ms',
              }}
            >
              {copied ? '✓ Copied!' : 'Copy prompt'}
            </button>
            {!copied && (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                or select all and press ⌘C
              </span>
            )}
          </div>
          {invite && (
            <div style={{
              marginTop: 10, padding: '8px 12px',
              background: 'var(--tint-lavender)', borderRadius: 'var(--radius-sm)',
              fontSize: 12, color: 'var(--tint-lavender-text)',
            }}>
              Token: <code style={{ fontFamily: 'var(--font-mono)' }}>{invite.token.slice(0, 12)}…</code> — one-time use, auto-rotates after registration.
            </div>
          )}
        </>
      )}
    </>
  );

  if (embedded) return <div>{content}</div>;

  // Standalone (legacy usage — kept for backward compat)
  return (
    <div style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'var(--surface1)', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 500 }}>
        Connect an Agent
      </div>
      <div style={{ padding: 14 }}>{content}</div>
    </div>
  );
}
