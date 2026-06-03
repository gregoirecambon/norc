import type { Agent, PingResult } from '../types.js';
import { pingOpenclaw } from './openclaw.js';
import { pingClaudeApi } from './claude-api.js';
import { pingHttp } from './http.js';

export async function pingAgent(agent: Agent): Promise<PingResult> {
  const start = Date.now();
  const config = agent.adapterConfig;

  switch (agent.adapterType) {
    case 'openclaw': return pingOpenclaw(config, start);
    case 'claude-api': return pingClaudeApi(config, start);
    case 'http': return pingHttp(config, start);
    default: return { ok: false, latencyMs: 0, error: `Unknown adapter type: ${String(agent.adapterType)}` };
  }
}
