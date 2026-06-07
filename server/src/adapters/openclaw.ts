import { WebSocket } from 'ws';
import { randomUUID, generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import type { PingResult } from '../types.js';
import type { DispatchResult } from './index.js';
import { emitLog } from '../lib/logger.js';

// OpenClaw wire-protocol negotiation range advertised on connect.
// The gateway accepts a client when maxProtocol >= its version && minProtocol <= its version.
// Advertising [3, 4] supports both older v3 gateways and current v4 gateways
// (OpenClaw 2026.5.x bumped PROTOCOL_VERSION 3 → 4). The device-auth signature
// payload is unchanged — the gateway still verifies the "v3" canonical format.
const MIN_PROTOCOL = 3;
const MAX_PROTOCOL = 4;

function rawDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map(e => Buffer.isBuffer(e) ? e : Buffer.from(String(e), 'utf8')),
    ).toString('utf8');
  }
  return String(data ?? '');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** Pull an agent's final text out of a `res` frame, across the shapes a gateway
 * might use. Returns '' when the frame is a bare ACK (no result carried). */
function extractResultText(frame: Record<string, unknown>): string {
  const candidates: unknown[] = [
    frame['result'],
    frame['text'],
    asRecord(frame['result'])?.['text'],
    asRecord(frame['result'])?.['message'],
    asRecord(frame['result'])?.['content'],
    asRecord(frame['payload'])?.['text'],
    asRecord(frame['payload'])?.['message'],
    asRecord(frame['payload'])?.['content'],
    asRecord(frame['payload'])?.['result'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

/** Pull an assistant message's text out of a `session.message` payload's message
 * object (role:'assistant', content:[{type:'text',text}] | string | .text). */
function extractAssistantText(message: unknown): string {
  const m = asRecord(message);
  if (!m || m['role'] !== 'assistant') return '';
  const content = m['content'];
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(c => { const r = asRecord(c); return r && typeof r['text'] === 'string' ? r['text'] : ''; })
      .filter(Boolean);
    if (parts.length) return parts.join('');
  }
  return typeof m['text'] === 'string' ? m['text'] : '';
}

/** Pull text from an OpenAI-compatible chat-completions response body. */
function extractChatCompletionText(body: unknown): string {
  const choices = asRecord(body)?.['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const msg = asRecord(asRecord(choices[0])?.['message']);
  const content = msg?.['content'];
  return typeof content === 'string' ? content : '';
}

// ─── WebSocket operator connection (for ping only) ───────────────────────────

async function probeGateway(url: string, authToken: string | null, timeoutMs = 3000): Promise<'ok' | 'challenge_only' | 'failed'> {
  return new Promise(resolve => {
    let completed = false;
    const ws = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });

    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      if (!completed) { completed = true; resolve('failed'); }
    }, timeoutMs);

    const finish = (status: 'ok' | 'challenge_only' | 'failed') => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      resolve(status);
    };

    ws.on('message', raw => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawDataToString(raw)); } catch { return; }

      const event = asRecord(parsed);
      if (event?.type === 'event' && event.event === 'connect.challenge') {
        const nonce = asRecord(event.payload)?.nonce;
        if (typeof nonce !== 'string' || !nonce) { finish('failed'); return; }

        ws.send(JSON.stringify({
          type: 'req',
          id: randomUUID(),
          method: 'connect',
          params: {
            minProtocol: MIN_PROTOCOL,
            maxProtocol: MAX_PROTOCOL,
            client: { id: 'openclaw-probe', version: '0.1.0', platform: process.platform, mode: 'probe' },
            role: 'operator',
            scopes: ['operator.admin'],
            ...(authToken ? { auth: { token: authToken } } : {}),
          },
        }));
        return;
      }

      if (event?.type === 'res') {
        finish(event.ok === true ? 'ok' : 'challenge_only');
      }
    });

    ws.on('error', () => finish('failed'));
    ws.on('close', () => { if (!completed) finish('failed'); });
  });
}

// ─── Node (role=node) WebSocket connection ───────────────────────────────────

// Ed25519 SPKI DER has a 12-byte ASN.1 header before the 32-byte raw key
const ED25519_SPKI_PREFIX_LEN = 12;

export interface WsKeypair {
  privateKeyPem: string;
  publicKeyB64: string;
  deviceId: string;
}

export function generateWsKeypair(): WsKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPub = spkiDer.subarray(ED25519_SPKI_PREFIX_LEN);
  const publicKeyB64 = rawPub.toString('base64url');
  const deviceId = createHash('sha256').update(rawPub).digest('hex');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicKeyB64, deviceId };
}

// Builds the OpenClaw v3 device-auth signature payload.
// Scopes are joined with comma; empty string for no scopes.
function buildDeviceSignaturePayload(params: {
  deviceId: string;
  role: 'operator' | 'node';
  scopes: string[];
  signedAtMs: number;
  nonce: string;
}): string {
  const clientId = params.role === 'node' ? 'node-host' : 'gateway-client';
  const clientMode = params.role === 'node' ? 'node' : 'backend';
  return [
    'v3',
    params.deviceId,
    clientId,
    clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    '',               // token (none for device-identity auth)
    params.nonce,
    process.platform, // platform
    '',               // deviceFamily
  ].join('|');
}

// Connects to an OpenClaw gateway using a device keypair.
// role='operator' with scopes=['operator.write'] is used for challenge delivery.
// role='node' is used only for the initial pairing request.
// Returns the open WebSocket on success, throws on failure.
async function connectWithDeviceIdentity(
  url: string,
  keypair: WsKeypair,
  role: 'operator' | 'node',
  scopes: string[],
  timeoutMs = 12_000,
): Promise<WebSocket> {
  const clientId = role === 'node' ? 'node-host' : 'gateway-client';
  const clientMode = role === 'node' ? 'node' : 'backend';

  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) { try { ws.close(); } catch { /* */ } reject(err); }
      else resolve(ws);
    };

    const timer = setTimeout(
      () => finish(new Error('WebSocket device connect timed out')),
      timeoutMs,
    );

    ws.on('message', raw => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawDataToString(raw)); } catch { return; }
      const frame = asRecord(parsed);

      if (frame?.type === 'event' && frame.event === 'connect.challenge') {
        const nonce = asRecord(frame.payload)?.nonce;
        if (typeof nonce !== 'string' || !nonce) {
          clearTimeout(timer);
          finish(new Error('Invalid connect.challenge nonce'));
          return;
        }
        const signedAtMs = Date.now();
        const payload = buildDeviceSignaturePayload({ deviceId: keypair.deviceId, role, scopes, signedAtMs, nonce });
        const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), keypair.privateKeyPem).toString('base64url');

        ws.send(JSON.stringify({
          type: 'req',
          id: randomUUID(),
          method: 'connect',
          params: {
            minProtocol: MIN_PROTOCOL,
            maxProtocol: MAX_PROTOCOL,
            client: { id: clientId, version: '0.1.0', platform: process.platform, mode: clientMode },
            role,
            scopes,
            device: { id: keypair.deviceId, publicKey: keypair.publicKeyB64, signedAt: signedAtMs, nonce, signature },
          },
        }));
        return;
      }

      if (frame?.type === 'res') {
        clearTimeout(timer);
        if (frame.ok === true) {
          finish();
        } else {
          finish(new Error(
            `Connect rejected: ${JSON.stringify(asRecord(frame.error)?.message ?? frame.error)}`,
          ));
        }
      }
    });

    ws.on('error', e => { clearTimeout(timer); finish(e as Error); });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (!done) finish(new Error(`Connection closed: ${code} ${reason.toString()}`));
    });
  });
}

export type WsPairResult =
  | { status: 'paired' }
  | { status: 'pending' }
  | { status: 'failed'; error: string };

// Initiates node pairing: connects as node, which auto-creates a pairing request
// in OpenClaw's Control UI. Returns 'paired' if already registered, 'pending' if
// the pairing request was just created and needs approval, 'failed' on error.
export async function initiateWsPairing(
  config: Record<string, unknown>,
  agentName: string,
): Promise<WsPairResult> {
  const url = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!url) return { status: 'failed', error: 'adapterConfig.url is required' };

  const keypair = readKeypairFromConfig(config);
  if (!keypair) return { status: 'failed', error: 'No keypair found — generate one first' };

  // Connect as operator with operator.write scope.
  // On first connect (not yet approved): OpenClaw creates a pairing request and rejects → pending.
  // After admin approval in Control UI: connection succeeds → paired.
  const OPERATOR_SCOPES = ['operator.write', 'operator.read'];
  try {
    const ws = await connectWithDeviceIdentity(url, keypair, 'operator', OPERATOR_SCOPES);
    ws.close();
    return { status: 'paired' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "pairing required" / "NOT_PAIRED" / "role-upgrade": device identity was valid,
    // OpenClaw created a pairing request — user needs to approve in Control UI,
    // granting operator role with operator.write scope.
    if (
      msg.includes('pairing required') ||
      msg.includes('NOT_PAIRED') ||
      msg.includes('not approved yet') ||
      msg.includes('role-upgrade')
    ) {
      return { status: 'pending' };
    }
    return { status: 'failed', error: msg };
  }
}

function readKeypairFromConfig(config: Record<string, unknown>): WsKeypair | null {
  const privateKeyPem = typeof config['wsPrivateKey'] === 'string' ? config['wsPrivateKey'] : null;
  const publicKeyB64 = typeof config['wsPublicKey'] === 'string' ? config['wsPublicKey'] : null;
  const deviceId = typeof config['wsDeviceId'] === 'string' ? config['wsDeviceId'] : null;
  if (!privateKeyPem || !publicKeyB64 || !deviceId) return null;
  return { privateKeyPem, publicKeyB64, deviceId };
}

// ─── Challenge delivery ───────────────────────────────────────────────────────

export async function sendOpenclawChallenge(
  config: Record<string, unknown>,
  agentName: string,
  handshakeId: string,
  nonce: string,
  callbackUrl: string,
): Promise<void> {
  const wsUrl = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!wsUrl) throw new Error('adapterConfig.url is required');

  const authToken = typeof config['authToken'] === 'string' ? config['authToken'] : null;
  const keypair = readKeypairFromConfig(config);
  const ocAgentId = typeof config['agentId'] === 'string' && config['agentId'].trim()
    ? config['agentId'].trim()
    : agentName;

  const tokenReminder = authToken
    ? `\n\nIf this test ever fails again with a gateway auth error:\n  openclaw config set gateway.auth.mode token\n  openclaw config set gateway.auth.token ${authToken}\n  openclaw gateway restart`
    : '';
  const message = `Norc handshake test. Make a POST request to ${callbackUrl} with JSON body {"nonce":"${nonce}"}. Use bash or any available tool.${tokenReminder}`;

  if (keypair) {
    await sendChallengeViaWebSocket(wsUrl, keypair, ocAgentId, handshakeId, message, 'handshake');
  } else {
    await sendChallengeViaHttp(wsUrl, authToken, ocAgentId, handshakeId, message, 'handshake');
  }
}

/**
 * Push an arbitrary instruction to an OpenClaw agent (e.g. "update your skill").
 * Same transport as the handshake: connect as operator and invoke `method:'agent'`
 * (or the HTTP fallback). Best-effort, fresh connect→send→disconnect.
 */
export async function sendOpenclawMessage(
  config: Record<string, unknown>,
  agentName: string,
  message: string,
  sessionKind: string,
): Promise<void> {
  const wsUrl = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!wsUrl) throw new Error('adapterConfig.url is required');
  const authToken = typeof config['authToken'] === 'string' ? config['authToken'] : null;
  const keypair = readKeypairFromConfig(config);
  const ocAgentId = typeof config['agentId'] === 'string' && config['agentId'].trim()
    ? config['agentId'].trim()
    : agentName;
  const idKey = `${sessionKind}-${Date.now()}`;
  if (keypair) {
    await sendChallengeViaWebSocket(wsUrl, keypair, ocAgentId, idKey, message, sessionKind);
  } else {
    await sendChallengeViaHttp(wsUrl, authToken, ocAgentId, idKey, message, sessionKind);
  }
}

const OPERATOR_SCOPES = ['operator.write', 'operator.read'];

async function sendChallengeViaWebSocket(
  wsUrl: string,
  keypair: WsKeypair,
  ocAgentId: string,
  idKey: string,
  message: string,
  sessionKind: string,
): Promise<void> {
  const ws = await connectWithDeviceIdentity(wsUrl, keypair, 'operator', OPERATOR_SCOPES);

  const reqId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const ackTimeout = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error('Timed out waiting for agent method ack'));
    }, 10_000);

    ws.on('message', raw => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawDataToString(raw)); } catch { return; }
      const frame = asRecord(parsed);
      if (frame?.id === reqId) {
        clearTimeout(ackTimeout);
        try { ws.close(); } catch { /* */ }
        if (frame.ok === true) resolve();
        else reject(new Error(`agent method rejected: ${JSON.stringify(frame.error)}`));
      }
    });

    ws.send(JSON.stringify({
      type: 'req',
      id: reqId,
      method: 'agent',
      params: {
        message,
        agentId: ocAgentId,
        sessionKey: `agent:${ocAgentId}:norc:${sessionKind}:${idKey}`,
        idempotencyKey: idKey,
        timeout: 60000,
      },
    }));
  });
}

async function sendChallengeViaHttp(
  wsUrl: string,
  authToken: string | null,
  ocAgentId: string,
  idKey: string,
  message: string,
  sessionKind: string,
): Promise<void> {
  if (!authToken) throw new Error('adapterConfig.authToken is required when WebSocket pairing is not set up — use the "Setup WebSocket" button or set authToken in Adapter Config');

  const httpBase = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

  const response = await fetch(`${httpBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'x-openclaw-session-key': `agent:${ocAgentId}:norc:${sessionKind}:${idKey}`,
    },
    body: JSON.stringify({
      model: `openclaw/${ocAgentId}`,
      messages: [{ role: 'user', content: message }],
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenClaw HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Dispatch (agent turn) ────────────────────────────────────────────────────

/**
 * Dispatch an agent turn to OpenClaw. The wire transport is ACK-only, so this is
 * normally ASYNC: NORC pushes the prompt, the (tool-capable) agent does the work
 * and reports back through the NORC Agent API (the run token is in the prompt).
 *   - WebSocket path: returns the agent text if the gateway carries it in the
 *     `res` frame, otherwise `{ async: true }` (await the Agent-API callback).
 *   - HTTP path: the chat-completions endpoint returns the text synchronously.
 * `sessionId` (the page id) gives OpenClaw a stable per-page session key so it
 * keeps its own conversational memory across turns on the same page.
 */
export interface OpenclawDispatchOpts {
  /** Max ms to wait capturing the reply before falling back to async. Default WS_CAPTURE_MS. */
  captureMs?: number;
  /** 'healthcheck' uses one stable per-agent session so heartbeat pings don't litter task sessions. */
  sessionKind?: 'task' | 'healthcheck';
}

export async function dispatchOpenclaw(
  config: Record<string, unknown>,
  agentName: string,
  system: string,
  prompt: string,
  sessionId?: string,
  opts?: OpenclawDispatchOpts,
): Promise<DispatchResult> {
  const wsUrl = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!wsUrl) return { ok: false, supported: true, error: 'adapterConfig.url is required' };

  const authToken = typeof config['authToken'] === 'string' ? config['authToken'] : null;
  const keypair = readKeypairFromConfig(config);
  const ocAgentId = typeof config['agentId'] === 'string' && config['agentId'].trim()
    ? config['agentId'].trim()
    : agentName;
  const message = system ? `${system}\n\n${prompt}` : prompt;
  const idKey = sessionId && sessionId.trim() ? sessionId.trim() : `task-${Date.now()}`;
  const captureMs = opts?.captureMs ?? WS_CAPTURE_MS;
  const sessionKey = (opts?.sessionKind ?? 'task') === 'healthcheck'
    ? `agent:${ocAgentId}:norc:healthcheck`
    : `agent:${ocAgentId}:norc:task:${idKey}`;

  try {
    const text = keypair
      ? await dispatchViaWebSocket(wsUrl, keypair, ocAgentId, idKey, message, agentName, sessionKey, captureMs)
      : await dispatchViaHttp(wsUrl, authToken, ocAgentId, message, sessionKey, captureMs);
    if (text && text.trim()) return { ok: true, supported: true, text: text.trim() };
    // Bare ACK — the agent will report back via the Agent API.
    return { ok: true, supported: true, async: true };
  } catch (err) {
    return { ok: false, supported: true, error: err instanceof Error ? err.message : 'OpenClaw dispatch failed' };
  }
}

// How long to keep the socket open capturing the agent's reply before giving up
// and falling back to the async (Agent-API / timeout-escalation) path.
const WS_CAPTURE_MS = Number(process.env['NORC_OPENCLAW_WAIT_MS']) || 120_000;

/**
 * Dispatch an agent run and CAPTURE its eventual reply over the same socket.
 * The gateway only ACKs `method:'agent'` with {runId, status:'accepted'} and runs
 * asynchronously — so we subscribe to the session's messages first, then wait for
 * the run to finish (agent.wait), accumulating the latest assistant message. This
 * recovers replies from agents that answer in their own chat without calling the
 * NORC Agent API. Returns the captured text, or '' (→ caller treats as async) on
 * timeout / no answer, preserving the existing escalation fallback.
 */
async function dispatchViaWebSocket(
  wsUrl: string,
  keypair: WsKeypair,
  ocAgentId: string,
  idKey: string,
  message: string,
  agentName: string,
  sessionKey: string,
  captureMs: number,
): Promise<string> {
  const ws = await connectWithDeviceIdentity(wsUrl, keypair, 'operator', OPERATOR_SCOPES);
  const subId = randomUUID();
  const reqId = randomUUID();
  const waitId = randomUUID();

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let latestAssistant = '';
    let ackText = '';

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* */ }
      resolve(text);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* */ }
      reject(err);
    };

    const timer = setTimeout(() => {
      emitLog(`openclaw: capture cap reached for session ${sessionKey}`, agentName);
      finish(latestAssistant || ackText);
    }, captureMs);

    ws.on('error', e => fail(e instanceof Error ? e : new Error('ws error')));
    ws.on('close', () => finish(latestAssistant || ackText));

    ws.on('message', raw => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawDataToString(raw)); } catch { return; }
      const frame = asRecord(parsed);
      if (!frame) return;

      // Agent output arrives as session.message event frames.
      const isSessionMsg = (frame['type'] === 'event' && frame['event'] === 'session.message') || frame['type'] === 'session.message';
      if (isSessionMsg) {
        const payload = asRecord(frame['payload']) ?? frame;
        if (!payload['sessionKey'] || payload['sessionKey'] === sessionKey) {
          const t = extractAssistantText(payload['message']).trim();
          if (t) latestAssistant = t;
        }
        return;
      }

      if (frame['type'] !== 'res') return;
      const id = frame['id'];

      if (id === reqId) {
        const dump = rawDataToString(raw);
        emitLog(`openclaw res frame: ${dump.length > 600 ? dump.slice(0, 600) + '…' : dump}`, agentName);
        if (frame['ok'] !== true) { fail(new Error(`agent method rejected: ${JSON.stringify(frame['error'])}`)); return; }
        // Some gateways answer synchronously in the ACK; honour that immediately.
        ackText = extractResultText(frame);
        if (ackText.trim()) { finish(ackText.trim()); return; }
        // Otherwise wait for the run to complete, capturing session messages.
        const runId = asRecord(frame['payload'])?.['runId'];
        if (typeof runId === 'string' && runId) {
          ws.send(JSON.stringify({ type: 'req', id: waitId, method: 'agent.wait', params: { runId, timeoutMs: captureMs } }));
        } else {
          // Bare ACK with no run handle — nothing to capture; treat as async.
          finish('');
        }
        return;
      }

      if (id === waitId) {
        const status = asRecord(frame['payload'])?.['status'];
        emitLog(`openclaw agent.wait: status=${String(status)} session=${sessionKey}`, agentName);
        finish(latestAssistant || ackText);
        return;
      }
      // id === subId (subscription ack) → nothing to do.
    });

    // Subscribe BEFORE dispatching so no message is missed, then dispatch.
    ws.send(JSON.stringify({ type: 'req', id: subId, method: 'sessions.messages.subscribe', params: { key: sessionKey } }));
    ws.send(JSON.stringify({
      type: 'req',
      id: reqId,
      method: 'agent',
      params: { message, agentId: ocAgentId, sessionKey, idempotencyKey: idKey, timeout: 60000 },
    }));
  });
}

async function dispatchViaHttp(
  wsUrl: string,
  authToken: string | null,
  ocAgentId: string,
  message: string,
  sessionKey: string,
  timeoutMs: number,
): Promise<string> {
  if (!authToken) throw new Error('adapterConfig.authToken is required when WebSocket pairing is not set up — use the "Setup WebSocket" button or set authToken in Adapter Config');

  const httpBase = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  const response = await fetch(`${httpBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({
      model: `openclaw/${ocAgentId}`,
      messages: [{ role: 'user', content: message }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenClaw HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return extractChatCompletionText(await response.json().catch(() => null));
}

// ─── Ping ─────────────────────────────────────────────────────────────────────

export async function pingOpenclaw(config: Record<string, unknown>, start: number): Promise<PingResult> {
  const url = typeof config['url'] === 'string' ? config['url'].trim() : '';
  if (!url) return { ok: false, latencyMs: 0, error: 'adapterConfig.url is required for openclaw adapter' };

  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch {
    return { ok: false, latencyMs: 0, error: `Invalid URL: ${url}` };
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    return { ok: false, latencyMs: 0, error: `URL must use ws:// or wss://, got ${parsedUrl.protocol}` };
  }

  const authToken = typeof config['authToken'] === 'string' ? config['authToken'] : null;

  try {
    const result = await probeGateway(url, authToken);
    const latencyMs = Date.now() - start;
    if (result === 'ok') return { ok: true, latencyMs };
    if (result === 'challenge_only') return { ok: true, latencyMs, detail: 'challenge_only — gateway reachable but credentials rejected' };
    return { ok: false, latencyMs, error: 'Gateway probe failed (timeout or connection refused)' };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
