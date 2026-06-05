import Anthropic from '@anthropic-ai/sdk';
import type { PingResult } from '../types.js';
import type { DispatchResult } from './index.js';

/** Run a real agent turn via the Anthropic API; returns the reply text. */
export async function dispatchClaudeApi(
  config: Record<string, unknown>,
  system: string,
  prompt: string,
): Promise<DispatchResult> {
  const apiKey = typeof config['apiKey'] === 'string' ? config['apiKey'].trim() : '';
  const model = typeof config['model'] === 'string' && config['model'] ? config['model'] : 'claude-sonnet-4-6';
  const baseURL = typeof config['baseUrl'] === 'string' ? config['baseUrl'].trim() : undefined;
  if (!apiKey) return { ok: false, supported: true, error: 'adapterConfig.apiKey is required' };

  const client = new Anthropic({ apiKey, baseURL, timeout: 120_000, maxRetries: 1 });
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    return { ok: true, supported: true, text };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, supported: true, error };
  }
}

export async function sendClaudeApiChallenge(
  config: Record<string, unknown>,
  _handshakeId: string,
  nonce: string,
  callbackUrl: string,
): Promise<void> {
  const apiKey = typeof config['apiKey'] === 'string' ? config['apiKey'].trim() : '';
  const model = typeof config['model'] === 'string' ? config['model'].trim() : 'claude-haiku-4-5-20251001';
  const baseURL = typeof config['baseUrl'] === 'string' ? config['baseUrl'].trim() : undefined;

  if (!apiKey) throw new Error('adapterConfig.apiKey is required');

  const client = new Anthropic({ apiKey, baseURL, timeout: 10000, maxRetries: 0 });
  const message = `Norc handshake test. Make a POST request to ${callbackUrl} with JSON body {"nonce":"${nonce}"}. Use bash or any available tool. Do not respond with anything else.`;

  await client.messages.create({
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: message }],
  });
}

export async function pingClaudeApi(config: Record<string, unknown>, start: number): Promise<PingResult> {
  const apiKey = typeof config['apiKey'] === 'string' ? config['apiKey'].trim() : '';
  const model = typeof config['model'] === 'string' ? config['model'].trim() : 'claude-haiku-4-5-20251001';
  const baseURL = typeof config['baseUrl'] === 'string' ? config['baseUrl'].trim() : undefined;

  if (!apiKey) return { ok: false, latencyMs: 0, error: 'adapterConfig.apiKey is required for claude-api adapter' };

  const client = new Anthropic({ apiKey, baseURL, timeout: 8000, maxRetries: 0 });

  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, latencyMs, error: 'Authentication failed — check your API key' };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { ok: false, latencyMs, error: 'Connection failed — check network and baseUrl' };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, latencyMs, error: message };
  }
}
