import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsType } from 'ws';
import type { AddressInfo } from 'node:net';
import { dispatchOpenclaw, probeOpenclawRun, generateWsKeypair } from '../adapters/openclaw.js';

// A fake OpenClaw gateway. Modes:
//  - 'result':  agent res carries result.text (sync answer)
//  - 'ack':     bare ACK, no runId (async — agent must use the Agent API)
//  - 'capture': ACK with runId; on agent.wait, emits a session.message assistant
//               frame then a terminal wait res (NORC captures the reply over WS)
//  - 'stall':   ACK with runId but never answers agent.wait (capture timer fires)
// Received frames are recorded so tests can assert on what was sent.
function startFakeGateway(mode: 'result' | 'ack' | 'capture' | 'stall'): Promise<{ url: string; close: () => void; frames: Record<string, any>[] }> {
  return new Promise(resolve => {
    const frames: Record<string, any>[] = [];
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close(), frames });
    });
    wss.on('connection', (ws: WsType) => {
      ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true }));
        } else if (frame.method === 'sessions.messages.subscribe') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { subscribed: true } }));
        } else if (frame.method === 'agent') {
          const res: Record<string, unknown> = { type: 'res', id: frame.id, ok: true };
          if (mode === 'result') res['result'] = { text: 'agent answer here' };
          if (mode === 'capture' || mode === 'stall') res['payload'] = { runId: 'run-1', status: 'accepted' };
          ws.send(JSON.stringify(res));
        } else if (frame.method === 'agent.wait') {
          if (mode === 'stall') return; // never answers — the capture timer must fire
          if (mode === 'capture') {
            ws.send(JSON.stringify({
              type: 'event', event: 'session.message',
              payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'captured reply' }] } },
            }));
          }
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { runId: 'run-1', status: 'ok' } }));
        }
      });
    });
  });
}

const keypairConfig = () => {
  const kp = generateWsKeypair();
  return { wsPrivateKey: kp.privateKeyPem, wsPublicKey: kp.publicKeyB64, wsDeviceId: kp.deviceId };
};

describe('dispatchOpenclaw (WebSocket)', () => {
  let gateway: { url: string; close: () => void; frames: Record<string, any>[] } | null = null;
  afterEach(() => { gateway?.close(); gateway = null; });

  it('returns the agent text synchronously when the gateway carries a result', async () => {
    gateway = await startFakeGateway('result');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.ok).toBe(true);
    expect(res.supported).toBe(true);
    expect(res.text).toBe('agent answer here');
    expect(res.async).toBeUndefined();
    // The agent-facing session key is surfaced for the dashboard / debugging.
    expect(res.sessionKey).toBe('agent:emilien:norc:task:page-1');
  });

  it('returns async:true on a bare ACK (reply comes via the Agent API)', async () => {
    gateway = await startFakeGateway('ack');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.ok).toBe(true);
    expect(res.async).toBe(true);
    expect(res.text).toBeUndefined();
    // The session key is known before the send, so it's returned on the async path too.
    expect(res.sessionKey).toBe('agent:emilien:norc:task:page-1');
  });

  it('captures the agent reply over WS (subscribe + agent.wait) when ACK has a runId', async () => {
    gateway = await startFakeGateway('capture');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.ok).toBe(true);
    expect(res.text).toBe('captured reply');
    expect(res.async).toBeUndefined();
    expect(res.openclawRunId).toBe('run-1'); // surfaced for later liveness probing
  });

  it('surfaces the OpenClaw run handle on the async path (stall → no reply captured)', async () => {
    gateway = await startFakeGateway('stall');
    const res = await dispatchOpenclaw(
      { url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1',
      { captureMs: 500 },
    );
    expect(res.async).toBe(true);
    expect(res.openclawRunId).toBe('run-1');
  });

  it('has no run handle on a bare ACK (no runId)', async () => {
    gateway = await startFakeGateway('ack');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.async).toBe(true);
    expect(res.openclawRunId).toBeNull();
  });

  it('healthcheck dispatches use the stable healthcheck session and honour captureMs', async () => {
    gateway = await startFakeGateway('stall');
    const startedAt = Date.now();
    const res = await dispatchOpenclaw(
      { url: gateway.url, ...keypairConfig() }, 'emilien', '', 'health check', undefined,
      { sessionKind: 'healthcheck', captureMs: 500 },
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000); // gave up at captureMs, not the 120s default
    expect(res.ok).toBe(true);
    expect(res.async).toBe(true); // no reply captured

    const agentFrame = gateway.frames.find(f => f['method'] === 'agent');
    expect(agentFrame?.['params']?.['sessionKey']).toBe('agent:emilien:norc:healthcheck');
  });
});

describe('dispatchOpenclaw (config guards)', () => {
  it('errors (supported) when no url is configured', async () => {
    const res = await dispatchOpenclaw({}, 'emilien', 'SYS', 'hi');
    expect(res).toEqual({ ok: false, supported: true, error: 'adapterConfig.url is required' });
  });

  it('errors when neither keypair nor authToken is available', async () => {
    const res = await dispatchOpenclaw({ url: 'ws://127.0.0.1:1' }, 'emilien', 'SYS', 'hi');
    expect(res.ok).toBe(false);
    expect(res.supported).toBe(true);
    expect(res.error).toContain('authToken');
  });
});

// A fake gateway that answers a standalone agent.wait probe with a chosen status
// (null = never answers, simulating a still-blocking run).
function startProbeGateway(status: string | null): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
    wss.on('connection', (ws: WsType) => {
      ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } }));
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true }));
        } else if (frame.method === 'agent.wait') {
          if (status === null) return; // never answers — the probe's own ceiling fires
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { runId: frame.params.runId, status } }));
        }
      });
    });
  });
}

describe('probeOpenclawRun (confirm-before-kill)', () => {
  let gw: { url: string; close: () => void } | null = null;
  afterEach(() => { gw?.close(); gw = null; delete process.env['NORC_OPENCLAW_PROBE_MS']; delete process.env['NORC_PROBE']; });

  it('reports DEAD on a terminal status (run finished without reporting back)', async () => {
    gw = await startProbeGateway('ok');
    const res = await probeOpenclawRun({ url: gw.url, ...keypairConfig() }, 'run-1');
    expect(res.alive).toBe(false);
    expect(res.status).toBe('ok');
  });

  it('reports ALIVE on a non-terminal status (still running)', async () => {
    gw = await startProbeGateway('running');
    const res = await probeOpenclawRun({ url: gw.url, ...keypairConfig() }, 'run-1');
    expect(res.alive).toBe(true);
  });

  it('fails open (ALIVE) when the gateway never answers (blocking run)', async () => {
    process.env['NORC_OPENCLAW_PROBE_MS'] = '150'; // ceiling ~190ms, keeps the test fast
    gw = await startProbeGateway(null);
    const res = await probeOpenclawRun({ url: gw.url, ...keypairConfig() }, 'run-1');
    expect(res.alive).toBe(true);
  });

  it('fails open (ALIVE) when the gateway is unreachable', async () => {
    const res = await probeOpenclawRun({ url: 'ws://127.0.0.1:1', ...keypairConfig() }, 'run-1');
    expect(res.alive).toBe(true);
  });

  it('fails open (ALIVE) when no WS keypair is configured (cannot probe)', async () => {
    const res = await probeOpenclawRun({ url: 'ws://127.0.0.1:1' }, 'run-1');
    expect(res.alive).toBe(true);
  });

  it('NORC_PROBE=0 disables probing (reports dead → caller uses pure idle-timeout)', async () => {
    process.env['NORC_PROBE'] = '0';
    gw = await startProbeGateway('running');
    const res = await probeOpenclawRun({ url: gw.url, ...keypairConfig() }, 'run-1');
    expect(res.alive).toBe(false);
  });
});
