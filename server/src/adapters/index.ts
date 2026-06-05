import type { Agent, PingResult, AdapterType } from '../types.js';
import { pingOpenclaw, sendOpenclawMessage } from './openclaw.js';
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
  /** Whether the agent turn succeeded (text present) or errored (error present). */
  ok: boolean;
  /** False when this adapter has no dispatch implementation yet (e.g. openclaw, Phase 3). */
  supported: boolean;
  text?: string;
  error?: string;
}

export interface DispatchArgs {
  adapterType: AdapterType;
  config: Record<string, unknown>;
  system: string;
  prompt: string;
}

const DISPATCH_SUPPORTED = new Set<AdapterType>(['claude-api', 'http', 'claude-local', 'codex-local']);

/** Whether dispatch is wired for this adapter (openclaw lands in a later phase). */
export function dispatchSupported(adapterType: AdapterType): boolean {
  return DISPATCH_SUPPORTED.has(adapterType);
}

/** Run one agent turn synchronously and return its reply text. */
export async function dispatch(args: DispatchArgs): Promise<DispatchResult> {
  const { adapterType, config, system, prompt } = args;
  switch (adapterType) {
    case 'claude-api': return dispatchClaudeApi(config, system, prompt);
    case 'http': return dispatchHttp(config, system, prompt);
    case 'claude-local': return dispatchLocalCli(config, system, prompt, 'claude');
    case 'codex-local': return dispatchLocalCli(config, system, prompt, 'codex');
    case 'openclaw':
      return { ok: false, supported: false, error: 'OpenClaw dispatch is not wired yet (coming in a later phase)' };
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
