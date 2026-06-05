import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsType } from 'ws';
import type { AddressInfo } from 'node:net';
import { dispatchOpenclaw, generateWsKeypair } from '../adapters/openclaw.js';

// A fake OpenClaw gateway: completes the device-auth handshake, then answers the
// `agent` request either with a result-bearing `res` (sync) or a bare ACK (async).
function startFakeGateway(mode: 'result' | 'ack'): Promise<{ url: string; close: () => void }> {
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
        } else if (frame.method === 'agent') {
          const res: Record<string, unknown> = { type: 'res', id: frame.id, ok: true };
          if (mode === 'result') res['result'] = { text: 'agent answer here' };
          ws.send(JSON.stringify(res));
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
  let gateway: { url: string; close: () => void } | null = null;
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
