import type { Agent } from '../types.js';
import { sendOpenclawChallenge } from './openclaw.js';
import { sendClaudeApiChallenge } from './claude-api.js';
import { sendHttpChallenge } from './http.js';

export async function sendHandshakeChallenge(
  agent: Agent,
  handshakeId: string,
  nonce: string,
  callbackUrl: string,
): Promise<void> {
  switch (agent.adapterType) {
    case 'openclaw':
      await sendOpenclawChallenge(agent.adapterConfig, agent.name, handshakeId, nonce, callbackUrl);
      break;
    case 'claude-api':
      await sendClaudeApiChallenge(agent.adapterConfig, handshakeId, nonce, callbackUrl);
      break;
    case 'http':
      await sendHttpChallenge(agent.adapterConfig, handshakeId, nonce, callbackUrl);
      break;
  }
}
