import { useState, useEffect, useRef } from 'react';
import {
  getNotionConfig, saveNotionKey, deleteNotionIntegration, provisionWorkspace,
  type NotionConfig, type NotionIntegration, type NotionDatabase,
} from '../api/notion.js';

/** Compact relative time, e.g. "just now", "5 min ago", "2 h ago", "3 d ago". */
function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec} s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.floor(hr / 24);
  return `${d} d ago`;
}

const REQUIRED_CAPABILITIES = [
  'Read content',
  'Update content',
  'Insert content',
  'Read users (without email)',
  'Comments',
];

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11, fontWeight: 600,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.6px',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  background: 'var(--surface1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
  boxSizing: 'border-box',
};

const sectionStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '20px 24px',
  marginBottom: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 16,
  display: 'flex', alignItems: 'center', gap: 8,
};

const stepBadgeStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: '50%',
  fontSize: 11, fontWeight: 700,
  background: active ? 'var(--primary)' : 'var(--border)',
  color: active ? 'var(--on-primary)' : 'var(--text-dim)',
  flexShrink: 0,
});

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      style={{
        padding: '6px 12px',
        background: copied ? 'var(--tint-mint)' : 'var(--primary)',
        color: copied ? 'var(--tint-mint-text)' : 'var(--on-primary)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        fontSize: 12, fontWeight: 500,
        cursor: 'pointer', flexShrink: 0,
        transition: 'background 150ms, color 150ms',
      }}
    >
      {copied ? '✓ Copied!' : label}
    </button>
  );
}

export default function NotionPage() {
  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState(false);

  const [pageInput, setPageInput] = useState('');
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [, setNow] = useState(Date.now()); // ticker so "time ago" stays current

  // Re-render every 30s to refresh relative timestamps.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const integration = config?.integration ?? null;
  const webhookUrl = config?.webhookUrl ?? '';
  const databases = config?.databases ?? [];
  const workspaceStatus = integration?.workspaceStatus ?? 'not_provisioned';

  useEffect(() => {
    getNotionConfig()
      .then(setConfig)
      .catch(() => setConfig({ integration: null, webhookUrl: '', databases: [] }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');

    es.addEventListener('notion.integration.updated', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status: string; workspaceName: string | null; botName: string | null;
        webhookVerifyToken: string | null; webhookUrl: string;
      };
      if (data.status === 'pending_key') {
        setConfig(prev => prev ? { ...prev, integration: null, databases: [] } : prev);
      } else {
        setConfig(prev => {
          const row = data as unknown as NotionIntegration;
          return prev ? { ...prev, integration: row } : { integration: row, webhookUrl: data.webhookUrl, databases: [] };
        });
      }
    });

    es.addEventListener('notion.workspace.updated', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        workspaceStatus: string; parentPageId: string | null; databases: NotionDatabase[];
      };
      setConfig(prev => {
        if (!prev) return prev;
        const integration = prev.integration
          ? { ...prev.integration, workspaceStatus: data.workspaceStatus as NotionIntegration['workspaceStatus'], parentPageId: data.parentPageId }
          : prev.integration;
        return { ...prev, integration, databases: data.databases };
      });
    });

    es.addEventListener('notion.verification_received', (e: Event) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        verificationToken: string; workspaceName: string | null; botName: string | null;
      };
      setConfig(prev => {
        if (!prev?.integration) return prev;
        return {
          ...prev,
          integration: { ...prev.integration, status: 'active', webhookVerifyToken: data.verificationToken, webhookVerifiedAt: Date.now(), updatedAt: Date.now() },
        };
      });
    });

    return () => es.close();
  }, []);

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setKeySaving(true);
    setKeyError(null);
    try {
      const row = await saveNotionKey(apiKeyInput.trim());
      setConfig(prev => ({ webhookUrl: row.webhookUrl, databases: [], ...(prev ?? {}), integration: row }));
      setApiKeyInput('');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to validate key');
    } finally {
      setKeySaving(false);
    }
  };

  const handleProvision = async () => {
    if (!pageInput.trim()) return;
    setProvisioning(true);
    setProvisionError(null);
    try {
      const dbs = await provisionWorkspace(pageInput.trim());
      setConfig(prev => prev ? {
        ...prev,
        databases: dbs,
        integration: prev.integration ? { ...prev.integration, workspaceStatus: 'provisioned' } : prev.integration,
      } : prev);
      setPageInput('');
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Failed to provision workspace');
    } finally {
      setProvisioning(false);
    }
  };

  const handleReset = async () => {
    try {
      await deleteNotionIntegration();
      setConfig(prev => prev ? { ...prev, integration: null, databases: [] } : prev);
      setApiKeyInput('');
      setKeyError(null);
      setPageInput('');
      setProvisionError(null);
    } catch {
      // ignore
    }
  };

  const step2Locked = !integration || integration.status === 'pending_key';
  const step3Locked = !integration || integration.status !== 'active';
  const step4Locked = !integration || integration.status !== 'active' || workspaceStatus !== 'provisioned';

  if (loading) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        <div style={{ width: 200, height: 24, background: 'var(--surface1)', borderRadius: 6 }} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32, maxWidth: 640 }}>
      <style>{`@keyframes norcPulse{0%,100%{opacity:.35}50%{opacity:1}}`}</style>

      <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.3px', color: 'var(--text-primary)', marginBottom: 6, marginTop: 0 }}>
        Notion
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24, marginTop: 0 }}>
        Connect your Notion workspace so NORC can receive webhooks and write agent outputs back to pages.
      </p>

      {/* Step 1 — API Key */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span style={stepBadgeStyle(true)}>1</span>
          API Key
        </div>

        {!integration || integration.status === 'pending_key' ? (
          <div>
            <label style={labelStyle} htmlFor="notion-key">Notion Integration Token</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: keyError ? 8 : 0 }}>
              <input
                id="notion-key"
                type="password"
                placeholder="secret_..."
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveKey(); }}
                style={inputStyle}
                autoComplete="off"
              />
              <button
                onClick={handleSaveKey}
                disabled={keySaving || !apiKeyInput.trim()}
                style={{
                  padding: '7px 16px',
                  background: 'var(--primary)',
                  color: 'var(--on-primary)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13, fontWeight: 500,
                  cursor: keySaving ? 'not-allowed' : 'pointer',
                  opacity: keySaving || !apiKeyInput.trim() ? 0.6 : 1,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {keySaving ? 'Verifying…' : 'Verify'}
              </button>
            </div>
            {keyError && (
              <div style={{ fontSize: 13, color: 'var(--accent-red)', marginTop: 8 }}>{keyError}</div>
            )}
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 10, marginBottom: 0 }}>
              Create an internal integration at{' '}
              <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--primary)' }}>
                notion.so/my-integrations
              </a>
              {' '}and paste the token above.
            </p>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <span style={{ color: 'var(--accent-green)', fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {integration.workspaceName ?? 'Connected'}
              </span>
              {integration.botName && (
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>· Bot: {integration.botName}</span>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ ...labelStyle, marginBottom: 8 }}>Required capabilities</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {REQUIRED_CAPABILITIES.map(cap => (
                  <div key={cap} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>○</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{cap}</span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, marginBottom: 0 }}>
                Ensure all capabilities are enabled in your{' '}
                <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--primary)' }}>
                  integration settings
                </a>.
              </p>
            </div>

            <button
              onClick={handleReset}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--text-dim)', fontSize: 12,
                cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              Change key
            </button>
          </div>
        )}
      </div>

      {/* Step 2 — Webhook */}
      <div style={{ ...sectionStyle, ...(step2Locked ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
        <div style={sectionTitleStyle}>
          <span style={stepBadgeStyle(!step2Locked)}>2</span>
          Webhook Setup
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Webhook URL</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{
              flex: 1, padding: '7px 10px',
              background: 'var(--surface1)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12, fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)', overflow: 'hidden',
              whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            }}>
              {webhookUrl || 'http://localhost:3001/webhooks/notion'}
            </div>
            <CopyButton text={webhookUrl} label="Copy" />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, marginBottom: 0 }}>
            Add this URL in Notion → Settings → Connections → Webhooks → Add endpoint.
          </p>
        </div>

        {!step2Locked && integration?.status === 'pending_webhook' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px',
            background: 'var(--surface1)', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            marginBottom: 0,
          }}>
            <span style={{ animation: 'norcPulse 1.5s ease-in-out infinite', color: 'var(--accent-amber)', fontSize: 10 }}>●</span>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Waiting for Notion to verify the webhook URL…
            </span>
          </div>
        )}

        {!step2Locked && integration?.status === 'active' && integration.webhookVerifyToken && (
          <div style={{
            padding: '14px 16px',
            background: 'var(--tint-sky)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tint-sky-text)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Verification secret received
              </span>
              <span
                title={new Date(integration.webhookVerifiedAt ?? integration.updatedAt).toLocaleString()}
                style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}
              >
                {timeAgo(integration.webhookVerifiedAt ?? integration.updatedAt)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <div style={{
                flex: 1, padding: '7px 10px',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11, fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)', overflow: 'hidden',
                whiteSpace: 'nowrap', textOverflow: 'ellipsis',
              }}>
                {integration.webhookVerifyToken}
              </div>
              <CopyButton text={integration.webhookVerifyToken} label="Copy secret" />
            </div>
            <p style={{ fontSize: 12, color: 'var(--tint-sky-text)', margin: 0 }}>
              Copy this secret and paste it into Notion's Webhook Secret field to complete verification.
            </p>
          </div>
        )}
      </div>

      {/* Step 3 — Workspace */}
      <div style={{ ...sectionStyle, ...(step3Locked ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
        <div style={sectionTitleStyle}>
          <span style={stepBadgeStyle(!step3Locked)}>3</span>
          Workspace
        </div>

        {workspaceStatus === 'provisioned' ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <span style={{ color: 'var(--accent-green)', fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                Workspace ready — {databases.length} {databases.length === 1 ? 'database' : 'databases'} created
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {databases.map(d => (
                <div key={d.notionDatabaseId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>▦</span>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)' }}>
                      {d.title}
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)' }}>{d.title}</span>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={handleReset}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--text-dim)', fontSize: 12,
                cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              Re-provision
            </button>
          </div>
        ) : (
          <div>
            <label style={labelStyle} htmlFor="notion-page">Parent page</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: provisionError ? 8 : 0 }}>
              <input
                id="notion-page"
                type="text"
                placeholder="https://notion.so/your-page-…"
                value={pageInput}
                onChange={e => setPageInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleProvision(); }}
                style={inputStyle}
                autoComplete="off"
              />
              <button
                onClick={handleProvision}
                disabled={provisioning || !pageInput.trim()}
                style={{
                  padding: '7px 16px',
                  background: 'var(--primary)',
                  color: 'var(--on-primary)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13, fontWeight: 500,
                  cursor: provisioning ? 'not-allowed' : 'pointer',
                  opacity: provisioning || !pageInput.trim() ? 0.6 : 1,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {provisioning ? 'Building…' : 'Provision databases'}
              </button>
            </div>
            {provisionError && (
              <div style={{ fontSize: 13, color: 'var(--accent-red)', marginTop: 8 }}>{provisionError}</div>
            )}
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 10, marginBottom: 0 }}>
              Paste a Notion page you've shared with the integration (open the page → ••• → Connections → add NORC).
              NORC will create the Org DB, Tasks, Projects, and Pipeline Config databases inside it.
            </p>
          </div>
        )}
      </div>

      {/* Step 4 — Complete */}
      <div style={{ ...sectionStyle, ...(step4Locked ? { opacity: 0.45, pointerEvents: 'none' } : {}) }}>
        <div style={sectionTitleStyle}>
          <span style={stepBadgeStyle(!step4Locked)}>4</span>
          Complete
        </div>

        {!step4Locked ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ color: 'var(--accent-green)', fontSize: 18 }}>✓</span>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                Connected to {integration!.workspaceName ?? 'Notion'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {[
                ['Bot', integration!.botName],
                ['Workspace', integration!.workspaceName],
                ['Databases', `${databases.length} provisioned`],
              ].map(([key, val]) => (
                <div key={key} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                  <span style={{ width: 80, color: 'var(--text-dim)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', paddingTop: 1 }}>{key}</span>
                  <span style={{ color: 'var(--text-primary)' }}>{val ?? '—'}</span>
                </div>
              ))}
            </div>
            <button
              onClick={handleReset}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: 'var(--text-dim)', fontSize: 12,
                cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              Reconfigure
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
            Complete Steps 1–3 to finish connecting your Notion workspace.
          </p>
        )}
      </div>
    </div>
  );
}
