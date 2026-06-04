import { useState, useEffect, useRef } from 'react';
import { startHandshake, getHandshakeStatus } from '../api/handshakes.js';
import type { AgentRow } from '../api/agents.js';

interface Props {
  agent: AgentRow;
  onResult: (id: string, status: 'connected' | 'unreachable', latencyMs: number) => void;
}

type State = 'idle' | 'sending' | 'waiting' | 'ok' | 'error';

export function HandshakeButton({ agent, onResult }: Props) {
  const [state, setState] = useState<State>('idle');
  const [detail, setDetail] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolvedRef = useRef(false);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const resolve = (ok: boolean, latencyMs: number, errorMsg?: string) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    stopPolling();
    if (ok) {
      setState('ok');
      setDetail(`${latencyMs}ms`);
      onResult(agent.id, 'connected', latencyMs);
    } else {
      setState('error');
      setDetail((errorMsg ?? 'Timed out').slice(0, 40));
      onResult(agent.id, 'unreachable', 0);
    }
    setTimeout(() => { setState('idle'); resolvedRef.current = false; }, 5000);
  };

  const handleClick = async () => {
    if (state === 'sending' || state === 'waiting') return;
    setState('sending');
    setDetail('');
    stopPolling();
    resolvedRef.current = false;

    try {
      const { handshakeId } = await startHandshake(agent.id);
      setState('waiting');

      // Fallback polling every 3s (SSE updates in parent also update agent status)
      pollRef.current = setInterval(async () => {
        try {
          const status = await getHandshakeStatus(agent.id, handshakeId);
          if (status.status === 'completed') {
            resolve(true, status.latencyMs ?? 0);
          } else if (status.status === 'timed_out') {
            resolve(false, 0, status.error ?? 'Timed out');
          }
        } catch { /* keep polling */ }
      }, 3000);

      // Hard timeout at 65s
      setTimeout(() => resolve(false, 0, 'Timed out'), 65_000);

    } catch {
      setState('error');
      setDetail('Failed to start');
      setTimeout(() => setState('idle'), 5000);
    }
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const color =
    state === 'ok' ? 'var(--accent-green)'
    : state === 'error' ? 'var(--accent-red)'
    : state === 'waiting' ? 'var(--accent-amber)'
    : 'var(--text-dim)';

  const label =
    state === 'sending' ? '○  Starting…'
    : state === 'waiting' ? '○  Waiting…'
    : state === 'ok' ? `●  OK  ${detail}`
    : state === 'error' ? `●  ${detail}`
    : 'Test';

  return (
    <button
      disabled={state === 'sending' || state === 'waiting'}
      onClick={handleClick}
      style={{
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        background: state === 'ok' ? 'var(--tint-mint)' : state === 'error' ? '#fde8e8' : 'var(--surface2)',
        color,
        cursor: (state === 'sending' || state === 'waiting') ? 'default' : 'pointer',
        opacity: (state === 'sending' || state === 'waiting') ? 0.7 : 1,
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-sans)',
        transition: 'all 120ms',
      }}
    >
      {label}
    </button>
  );
}
