import { useState } from 'react';
import { pingAgent } from '../api/agents.js';
import type { AgentRow } from '../api/agents.js';

interface Props {
  agent: AgentRow;
  onResult: (id: string, status: 'connected' | 'unreachable', latencyMs: number) => void;
}

type State = 'idle' | 'pending' | 'ok' | 'error';

export function PingButton({ agent, onResult }: Props) {
  const [state, setState] = useState<State>('idle');
  const [detail, setDetail] = useState('');

  const handleClick = async () => {
    if (state === 'pending') return;
    setState('pending');
    setDetail('');
    try {
      const res = await pingAgent(agent.id);
      if (res.ok) {
        setState('ok');
        setDetail(`${res.latencyMs}ms`);
        onResult(agent.id, 'connected', res.latencyMs);
      } else {
        setState('error');
        setDetail((res.error ?? 'Error').slice(0, 40));
        onResult(agent.id, 'unreachable', res.latencyMs);
      }
    } catch {
      setState('error');
      setDetail('Unreachable');
      onResult(agent.id, 'unreachable', 0);
    }
    setTimeout(() => setState('idle'), 5000);
  };

  const color =
    state === 'ok' ? 'var(--accent-green)'
    : state === 'error' ? 'var(--accent-red)'
    : 'var(--text-dim)';

  const label =
    state === 'pending' ? '○  Testing…'
    : state === 'ok' ? `●  OK  ${detail}`
    : state === 'error' ? `●  ${detail}`
    : 'Ping';

  return (
    <button
      disabled={state === 'pending'}
      onClick={handleClick}
      style={{
        fontSize: 11,
        padding: '3px 8px',
        borderRadius: 4,
        border: '1px solid var(--border)',
        background: 'var(--surface2)',
        color,
        cursor: state === 'pending' ? 'default' : 'pointer',
        opacity: state === 'pending' ? 0.6 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
