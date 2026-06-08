import { useState, useEffect } from 'react';
import { getSettings, saveSettings, testTriageConnection, type NorcSettings } from '../../api/settings.js';
import { provisionCompanyDb, provisionSchedulingFields, provisionDependencyFields, provisionBlockedStatus } from '../../api/notion.js';
import { inputStyle, labelStyle } from '../ui.js';

const saveBtn = {
  fontSize: 13, fontWeight: 500, padding: '8px 16px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--surface1)', color: 'var(--text-primary)',
} as const;
const checkRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--text-primary)' } as const;

export function TriageAgentPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [testState, setTestState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const test = async () => {
    if (!s) return;
    setTestState('busy'); setTestMsg('');
    try {
      const r = await testTriageConnection({
        provider: s.orchestratorProvider,
        model: s.orchestratorModel,
        baseUrl: s.orchestratorBaseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (r.ok) { setTestState('ok'); setTestMsg(`Connected${r.latencyMs != null ? ` (${r.latencyMs}ms)` : ''}${r.sample ? ` — replied “${r.sample}”` : ''}`); }
      else { setTestState('error'); setTestMsg(r.error ?? 'Connection failed'); }
    } catch (err) {
      setTestState('error'); setTestMsg(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const patch = {
        orchestratorEnabled: s.orchestratorEnabled,
        orchestratorProvider: s.orchestratorProvider,
        orchestratorBaseUrl: s.orchestratorBaseUrl,
        orchestratorModel: s.orchestratorModel,
        orchestratorSystemPrompt: s.orchestratorSystemPrompt,
        autoRouteThreshold: s.autoRouteThreshold,
        runTimeoutSec: s.runTimeoutSec,
        runHardCapSec: s.runHardCapSec,
        ...(apiKey.trim() ? { orchestratorApiKey: apiKey.trim() } : {}),
      };
      const next = await saveSettings(patch);
      setS(next); setApiKey(''); setState('saved'); setMsg('Saved.');
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;
  const isOpenAI = s.orchestratorProvider === 'openai';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={checkRow}>
        <input type="checkbox" checked={s.orchestratorEnabled} onChange={e => setS({ ...s, orchestratorEnabled: e.target.checked })} />
        Enable the NORC Triage Agent (triage unassigned tasks &amp; comments)
      </label>

      <div>
        <label style={labelStyle}>Provider</label>
        <select style={inputStyle} value={s.orchestratorProvider} onChange={e => setS({ ...s, orchestratorProvider: e.target.value as NorcSettings['orchestratorProvider'] })}>
          <option value="anthropic">Anthropic (direct)</option>
          <option value="openai">OpenAI-compatible (LiteLLM / proxy)</option>
        </select>
      </div>

      {isOpenAI && (
        <div>
          <label style={labelStyle}>Base URL (LiteLLM / OpenAI-compatible endpoint)</label>
          <input style={inputStyle} placeholder="http://localhost:4000" value={s.orchestratorBaseUrl ?? ''} onChange={e => setS({ ...s, orchestratorBaseUrl: e.target.value })} />
        </div>
      )}

      <div>
        <label style={labelStyle}>
          {isOpenAI ? 'API key (LiteLLM key — optional)' : 'Anthropic API key'} {s.orchestratorApiKeySet && <span style={{ color: 'var(--text-tertiary, #999)' }}>(set — leave blank to keep)</span>}
        </label>
        <input style={inputStyle} type="password" placeholder={s.orchestratorApiKeySet ? '••••••••' : (isOpenAI ? 'sk-… (optional)' : 'sk-ant-…')} value={apiKey} onChange={e => setApiKey(e.target.value)} />
      </div>

      <div>
        <label style={labelStyle}>Model {isOpenAI && <span style={{ color: 'var(--text-tertiary, #999)' }}>(as your proxy names it, e.g. gpt-4o or claude-sonnet-4-6)</span>}</label>
        <input style={inputStyle} value={s.orchestratorModel} onChange={e => setS({ ...s, orchestratorModel: e.target.value })} />
      </div>

      <div>
        <label style={labelStyle}>Auto-route threshold: <strong>{s.autoRouteThreshold.toFixed(2)}</strong> — at or above this confidence the Triage Agent dispatches directly; below it only suggests.</label>
        <input type="range" min={0} max={1} step={0.05} value={s.autoRouteThreshold} onChange={e => setS({ ...s, autoRouteThreshold: parseFloat(e.target.value) })} style={{ width: '100%' }} />
      </div>

      <div>
        <label style={labelStyle}>Idle timeout (seconds, min 60) — NORC escalates only after a routed agent has been silent (no API activity) this long. For OpenClaw agents it first probes whether the agent is still working and, if so, extends instead of killing.</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={60} value={s.runTimeoutSec}
          onChange={e => setS({ ...s, runTimeoutSec: parseInt(e.target.value || '300', 10) })} />
      </div>

      <div>
        <label style={labelStyle}>Hard cap (seconds, min 60) — absolute maximum a run may stay in flight before it's force-timed-out regardless of activity (runaway backstop). Raise it if your agents legitimately run longer.</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={60} value={s.runHardCapSec}
          onChange={e => setS({ ...s, runHardCapSec: parseInt(e.target.value || '1800', 10) })} />
      </div>

      <div>
        <label style={labelStyle}>Co-CEO system prompt (optional — overrides the default persona)</label>
        <textarea style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit', resize: 'vertical' }}
          value={s.orchestratorSystemPrompt ?? ''} onChange={e => setS({ ...s, orchestratorSystemPrompt: e.target.value })}
          placeholder="You are the NORC Triage Agent, a co-CEO who…" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={state === 'busy'} style={{ ...saveBtn, cursor: state === 'busy' ? 'default' : 'pointer' }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        <button onClick={test} disabled={testState === 'busy'} style={{ ...saveBtn, cursor: testState === 'busy' ? 'default' : 'pointer' }}>{testState === 'busy' ? 'Testing…' : 'Test connection'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
        {testMsg && <span style={{ fontSize: 12.5, color: testState === 'error' ? 'var(--danger, #d33)' : 'var(--success, #2a8)' }}>{testState === 'ok' ? '✓ ' : '✗ '}{testMsg}</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary, #999)' }}>
        Test uses the values above (leave the key blank to test with the saved one). It doesn't save.
      </div>
    </div>
  );
}

export function StrategicContextPanel() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const add = async () => {
    setState('busy'); setMsg('');
    try {
      const res = await provisionCompanyDb();
      setState('done');
      setMsg(res.created ? 'Company DB created — strategic agents now get company context.' : 'Company DB already exists.');
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <button onClick={add} disabled={state === 'busy'} style={{ ...saveBtn, padding: '8px 14px', cursor: state === 'busy' ? 'default' : 'pointer' }}>
        {state === 'busy' ? 'Adding…' : 'Add Company DB'}
      </button>
      {msg && <div style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</div>}
    </div>
  );
}

export function SchedulePanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [prov, setProv] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [provMsg, setProvMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const next = await saveSettings({ schedulerEnabled: s.schedulerEnabled });
      setS(next); setState('saved'); setMsg('Saved.');
    } catch (err) { setState('error'); setMsg(err instanceof Error ? err.message : 'Failed'); }
  };

  const addFields = async () => {
    setProv('busy'); setProvMsg('');
    try {
      await provisionSchedulingFields();
      setProv('done'); setProvMsg('Tasks DB now has Scheduled For / Recurrence / Repeat Every + Draft and Proposed statuses.');
    } catch (err) { setProv('error'); setProvMsg(err instanceof Error ? err.message : 'Failed'); }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        <button onClick={addFields} disabled={prov === 'busy'} style={{ ...saveBtn, padding: '8px 14px', cursor: prov === 'busy' ? 'default' : 'pointer' }}>
          {prov === 'busy' ? 'Adding…' : 'Add scheduling fields to Tasks DB'}
        </button>
        {provMsg && <div style={{ fontSize: 12.5, color: prov === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{provMsg}</div>}
      </div>
      <label style={checkRow}>
        <input type="checkbox" checked={s.schedulerEnabled} onChange={e => setS({ ...s, schedulerEnabled: e.target.checked })} />
        Run scheduled &amp; recurring tasks (poll the Tasks DB "Scheduled For" dates)
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={state === 'busy'} style={{ ...saveBtn, cursor: state === 'busy' ? 'default' : 'pointer' }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
      </div>
    </div>
  );
}

export function DependenciesPanel() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const add = async () => {
    setState('busy'); setMsg('');
    try {
      await provisionDependencyFields();
      setState('done');
      setMsg("Tasks DB now has a 'Depends On' relation (reverse: 'Blocks') + the 'Queued' status.");
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <button onClick={add} disabled={state === 'busy'} style={{ ...saveBtn, padding: '8px 14px', cursor: state === 'busy' ? 'default' : 'pointer' }}>
        {state === 'busy' ? 'Adding…' : 'Add dependency fields to Tasks DB'}
      </button>
      {msg && <div style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</div>}
    </div>
  );
}

export function BlockedStatusPanel() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const add = async () => {
    setState('busy'); setMsg('');
    try {
      await provisionBlockedStatus();
      setState('done');
      setMsg("Tasks DB now has the 'Blocked' status — agents park work here when they need your input.");
    } catch (err) {
      setState('error'); setMsg(err instanceof Error ? err.message : 'Failed');
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
      <button onClick={add} disabled={state === 'busy'} style={{ ...saveBtn, padding: '8px 14px', cursor: state === 'busy' ? 'default' : 'pointer' }}>
        {state === 'busy' ? 'Adding…' : "Add 'Blocked' status to Tasks DB"}
      </button>
      {msg && <div style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</div>}
    </div>
  );
}

export function ProposalsPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const next = await saveSettings({ autoProposeEnabled: s.autoProposeEnabled, autoProposeIntervalHours: s.autoProposeIntervalHours });
      setS(next); setState('saved'); setMsg('Saved.');
    } catch (err) { setState('error'); setMsg(err instanceof Error ? err.message : 'Failed'); }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={checkRow}>
        <input type="checkbox" checked={s.autoProposeEnabled} onChange={e => setS({ ...s, autoProposeEnabled: e.target.checked })} />
        Let the NORC Triage Agent propose new tasks on a schedule (human-validated)
      </label>
      <div>
        <label style={labelStyle}>Proposal interval (hours, 1–24) — the co-CEO reviews company context and creates "Proposed" tasks for you to approve.</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={1} max={24} value={s.autoProposeIntervalHours}
          onChange={e => setS({ ...s, autoProposeIntervalHours: Math.max(1, Math.min(24, parseInt(e.target.value || '12', 10))) })} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={state === 'busy'} style={{ ...saveBtn, cursor: state === 'busy' ? 'default' : 'pointer' }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
      </div>
    </div>
  );
}

export function HeartbeatPanel() {
  const [s, setS] = useState<NorcSettings | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  useEffect(() => { getSettings().then(setS).catch(() => setMsg('Could not load settings')); }, []);

  const save = async () => {
    if (!s) return;
    setState('busy'); setMsg('');
    try {
      const next = await saveSettings({
        heartbeatEnabled: s.heartbeatEnabled, heartbeatIntervalSec: s.heartbeatIntervalSec,
        deepPingEnabled: s.deepPingEnabled, deepPingIntervalSec: s.deepPingIntervalSec,
        failureNotifyThreshold: s.failureNotifyThreshold,
      });
      setS(next); setState('saved'); setMsg('Saved.');
    } catch (err) { setState('error'); setMsg(err instanceof Error ? err.message : 'Failed'); }
  };

  if (!s) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{msg || 'Loading…'}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
      <label style={checkRow}>
        <input type="checkbox" checked={s.heartbeatEnabled} onChange={e => setS({ ...s, heartbeatEnabled: e.target.checked })} />
        Periodically ping agents and reconcile their status
      </label>
      <div>
        <label style={labelStyle}>Interval (seconds, min 10)</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={10} value={s.heartbeatIntervalSec}
          onChange={e => setS({ ...s, heartbeatIntervalSec: parseInt(e.target.value || '60', 10) })} />
      </div>
      <label style={checkRow}>
        <input type="checkbox" checked={s.deepPingEnabled} onChange={e => setS({ ...s, deepPingEnabled: e.target.checked })} />
        Deep health checks — periodically send a real test prompt through each agent's AI (catches broken credentials behind a reachable gateway)
      </label>
      <div>
        <label style={labelStyle}>Deep check interval (seconds, min 60) — each check is a real AI call</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={60} value={s.deepPingIntervalSec}
          onChange={e => setS({ ...s, deepPingIntervalSec: parseInt(e.target.value || '600', 10) })} />
      </div>
      <div>
        <label style={labelStyle}>Notify after N consecutive failures (min 1) — @mentions the agent's Owner on its Org DB page, once per outage</label>
        <input style={{ ...inputStyle, maxWidth: 140 }} type="number" min={1} value={s.failureNotifyThreshold}
          onChange={e => setS({ ...s, failureNotifyThreshold: Math.max(1, parseInt(e.target.value || '2', 10)) })} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={state === 'busy'} style={{ ...saveBtn, cursor: state === 'busy' ? 'default' : 'pointer' }}>{state === 'busy' ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ fontSize: 12.5, color: state === 'error' ? 'var(--danger, #d33)' : 'var(--text-secondary)' }}>{msg}</span>}
      </div>
    </div>
  );
}
