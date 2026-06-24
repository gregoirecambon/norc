import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Dispatcher, type DispatchPayload } from './dispatch.js';
import { log } from './log.js';

type Body = DispatchPayload & { handshakeId?: string; nonce?: string; callbackUrl?: string };

/** Constant-time compare of the X-Norc-Secret header against the configured secret. */
function secretOk(provided: string | undefined, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Optional handshake: echo the nonce back to NORC's completion callback. */
async function respondChallenge(payload: { nonce?: string; callbackUrl?: string }): Promise<void> {
  if (!payload.callbackUrl || !payload.nonce) return;
  try {
    await fetch(payload.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: payload.nonce }),
      signal: AbortSignal.timeout(8000),
    });
    log('handshake challenge answered');
  } catch (err) {
    log(`handshake challenge failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

export function createWorkerServer(opts: {
  port: number;
  sharedSecret: string;
  dispatcher: Dispatcher;
}): http.Server {
  const { sharedSecret, dispatcher } = opts;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Health/ping — NORC's heartbeat does a bare GET. No auth (exposes no secrets).
    if (req.method === 'GET') { send(res, 200, { ok: true, service: 'norc-claude-worker' }); return; }
    if (req.method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }); return; }

    if (!secretOk(req.headers['x-norc-secret'] as string | undefined, sharedSecret)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    let payload: Body;
    try {
      payload = JSON.parse(await readBody(req)) as Body;
    } catch {
      send(res, 400, { error: 'invalid_json' });
      return;
    }

    switch (payload.type) {
      case 'norc_dispatch':
        // Ack immediately. The job runs in the background and reports back via the
        // Agent API (api_base in the prompt). 202 tells NORC to await that callback
        // rather than the 120s dispatch window.
        send(res, 202, { accepted: true, async: true });
        dispatcher.accept(payload);
        return;
      case 'norc_challenge':
        send(res, 200, { ok: true });
        void respondChallenge(payload);
        return;
      case 'norc_skill_update':
        // The worker carries the NORC contract in code — nothing to re-download.
        send(res, 200, { ok: true });
        return;
      default:
        send(res, 400, { error: 'unknown_type', type: payload.type ?? null });
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`request error: ${err instanceof Error ? err.message : 'unknown'}`);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
}
