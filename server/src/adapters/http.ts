import type { PingResult } from '../types.js';
import type { DispatchResult } from './index.js';

/**
 * Build request headers for an http-adapter call. Merges any operator-supplied
 * `config.headers`, then adds the `X-Norc-Secret` shared secret (when set) so the
 * remote worker can authenticate that the dispatch genuinely came from NORC. The
 * worker (e.g. norc-claude-worker) runs Claude Code with --dangerously-skip-permissions,
 * so an unauthenticated dispatch endpoint would be dangerous — the secret is the gate.
 */
export function httpHeaders(config: Record<string, unknown>): Record<string, string> {
  const extra = (typeof config['headers'] === 'object' && config['headers'] !== null)
    ? config['headers'] as Record<string, string>
    : {};
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  const secret = typeof config['sharedSecret'] === 'string' ? config['sharedSecret'].trim() : '';
  if (secret) headers['X-Norc-Secret'] = secret;
  return headers;
}

/** Dispatch an agent turn to a generic HTTP endpoint (e.g. the norc-claude-worker). */
export async function dispatchHttp(
  config: Record<string, unknown>,
  system: string,
  prompt: string,
): Promise<DispatchResult> {
  const url = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!url) return { ok: false, supported: true, error: 'adapterConfig.url is required' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: httpHeaders(config),
      body: JSON.stringify({ type: 'norc_dispatch', system, prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, supported: true, error: `HTTP ${res.status}` };

    // Async worker: a 202 — or a JSON ack of {async:true}/{accepted:true} — means the
    // job runs in the background and the reply arrives later via the Agent API, the
    // same contract as the openclaw adapter. Leave the run in-flight; don't wait for
    // the (multi-minute) Claude Code job inside the 120s dispatch window.
    if (res.status === 202) return { ok: true, supported: true, async: true };

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await res.json() as Record<string, unknown>;
      if (body['async'] === true || body['accepted'] === true) {
        return { ok: true, supported: true, async: true };
      }
      const text = typeof body['text'] === 'string' ? body['text']
        : typeof body['output'] === 'string' ? body['output']
        : JSON.stringify(body);
      return { ok: true, supported: true, text };
    }
    return { ok: true, supported: true, text: (await res.text()).trim() };
  } catch (err) {
    clearTimeout(timeout);
    const error = err instanceof Error
      ? (err.name === 'AbortError' ? 'Timeout after 120s' : err.message)
      : 'Unreachable';
    return { ok: false, supported: true, error };
  }
}

export async function sendHttpChallenge(
  config: Record<string, unknown>,
  handshakeId: string,
  nonce: string,
  callbackUrl: string,
): Promise<void> {
  const url = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!url) throw new Error('adapterConfig.url is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    await fetch(url, {
      method: 'POST',
      headers: httpHeaders(config),
      body: JSON.stringify({ type: 'norc_challenge', handshakeId, nonce, callbackUrl }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function pingHttp(config: Record<string, unknown>, start: number): Promise<PingResult> {
  const url = typeof config['url'] === 'string' ? config['url'].trim() : '';
  const method = typeof config['method'] === 'string' ? config['method'].toUpperCase() : 'GET';

  if (!url) return { ok: false, latencyMs: 0, error: 'adapterConfig.url is required for http adapter' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, { method, headers: httpHeaders(config), signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, latencyMs: Date.now() - start, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error
      ? (err.name === 'AbortError' ? 'Timeout after 5s' : err.message)
      : 'Unreachable';
    return { ok: false, latencyMs: Date.now() - start, error: message };
  }
}
