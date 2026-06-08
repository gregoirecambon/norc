import type { Agent, PingResult, AdapterType } from '../types.js';
import { pingOpenclaw, sendOpenclawMessage, dispatchOpenclaw } from './openclaw.js';
import { pingClaudeApi, dispatchClaudeApi } from './claude-api.js';
import { pingHttp, dispatchHttp } from './http.js';
import { pingLocalCli, dispatchLocalCli } from './local.js';

export async function pingAgent(agent: Agent): Promise<PingResult> {
  const start = Date.now();
  const config = agent.adapterConfig;

  switch (agent.adapterType) {
    case 'openclaw': return pingOpenclaw(config, start);
    case 'claude-api': return pingClaudeApi(config, start);
    case 'http': return pingHttp(config, start);
    case 'claude-local': return pingLocalCli(config, start, 'claude');
    case 'codex-local': return pingLocalCli(config, start, 'codex');
    default: return { ok: false, latencyMs: 0, error: `Unknown adapter type: ${String(agent.adapterType)}` };
  }
}

// --- Dispatch (agent turn) -------------------------------------------------

export interface DispatchResult {
  /** Whether the agent turn succeeded (text present / dispatched) or errored. */
  ok: boolean;
  /** False when this adapter has no dispatch implementation yet. */
  supported: boolean;
  /** True when dispatched but the reply arrives later via the Agent API (openclaw WS). */
  async?: boolean;
  text?: string;
  error?: string;
  /** OpenClaw-side run handle (when known) — persisted so the timeout sweep can
   * probe the run's liveness (agent.wait) before escalating. */
  openclawRunId?: string | null;
}

export interface DispatchArgs {
  adapterType: AdapterType;
  config: Record<string, unknown>;
  system: string;
  prompt: string;
  /** Agent display name — openclaw uses it as the agentId fallback. */
  agentName?: string;
  /** Stable session key (the page id) so openclaw keeps per-page memory. */
  sessionId?: string;
  /** Max ms to wait for a sync reply (openclaw capture window / HTTP abort). Default: adapter's own (~120s). */
  captureMs?: number;
  /** OpenClaw session namespace: 'task' (default, per-page) or 'healthcheck' (one stable session per agent). */
  sessionKind?: 'task' | 'healthcheck';
}

const DISPATCH_SUPPORTED = new Set<AdapterType>(['claude-api', 'http', 'claude-local', 'codex-local', 'openclaw']);

/** Whether dispatch is wired for this adapter. */
export function dispatchSupported(adapterType: AdapterType): boolean {
  return DISPATCH_SUPPORTED.has(adapterType);
}

/** Run one agent turn. Returns reply text (sync) or async:true (reply via Agent API). */
export async function dispatch(args: DispatchArgs): Promise<DispatchResult> {
  const { adapterType, config, system, prompt, agentName, sessionId } = args;
  switch (adapterType) {
    case 'claude-api': return dispatchClaudeApi(config, system, prompt);
    case 'http': return dispatchHttp(config, system, prompt);
    case 'claude-local': return dispatchLocalCli(config, system, prompt, 'claude');
    case 'codex-local': return dispatchLocalCli(config, system, prompt, 'codex');
    case 'openclaw': return dispatchOpenclaw(config, agentName ?? '', system, prompt, sessionId,
      { captureMs: args.captureMs, sessionKind: args.sessionKind });
    default:
      return { ok: false, supported: false, error: `Unknown adapter type: ${String(adapterType)}` };
  }
}

// --- Skill update notification --------------------------------------------

export interface SkillNotifyResult {
  pushed: boolean;
  reason?: string;
}

/** Best-effort push telling an agent to re-download its NORC skill. */
export async function notifySkillUpdate(
  agent: { name: string; adapterType: AdapterType; adapterConfig: Record<string, unknown> },
  skillUrl: string,
  version: number,
): Promise<SkillNotifyResult> {
  switch (agent.adapterType) {
    case 'openclaw': {
      const message =
        `NORC skill update available (v${version}). Fetch ${skillUrl} and replace your ` +
        `NORC skill file (e.g. ~/.norc/skills/norc.md). Acknowledge when done.`;
      await sendOpenclawMessage(agent.adapterConfig, agent.name, message, 'skill-update');
      return { pushed: true };
    }
    case 'http': {
      const url = typeof agent.adapterConfig['url'] === 'string' ? agent.adapterConfig['url'].trim() : '';
      if (!url) return { pushed: false, reason: 'no url configured' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'norc_skill_update', skillUrl, version }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { pushed: true } : { pushed: false, reason: `HTTP ${res.status}` };
    }
    default:
      // claude-local / codex-local / claude-api: no push channel.
      return { pushed: false, reason: 'no push channel — re-pulls the skill on next run' };
  }
}
