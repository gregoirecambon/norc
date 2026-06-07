import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsType } from 'ws';
import type { AddressInfo } from 'node:net';
import { dispatchOpenclaw, generateWsKeypair } from '../adapters/openclaw.js';

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
  });

  it('returns async:true on a bare ACK (reply comes via the Agent API)', async () => {
    gateway = await startFakeGateway('ack');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.ok).toBe(true);
    expect(res.async).toBe(true);
    expect(res.text).toBeUndefined();
  });

  it('captures the agent reply over WS (subscribe + agent.wait) when ACK has a runId', async () => {
    gateway = await startFakeGateway('capture');
    const res = await dispatchOpenclaw({ url: gateway.url, ...keypairConfig() }, 'emilien', 'SYS', 'do the thing', 'page-1');
    expect(res.ok).toBe(true);
    expect(res.text).toBe('captured reply');
    expect(res.async).toBeUndefined();
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
