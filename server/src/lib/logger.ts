import type { Response } from 'express';

const BUFFER_MAX = 2_000;
const BUFFER_TTL_MS = 24 * 60 * 60 * 1_000;

const buffer: string[] = [];
const bufferTs: number[] = [];
const listeners = new Set<(line: string) => void>();

export function emitLog(message: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[norc ${ts}] ${message}`;
  process.stdout.write(line + '\n');

  // Maintain ring buffer
  const now = Date.now();
  buffer.push(line);
  bufferTs.push(now);
  if (buffer.length > BUFFER_MAX) { buffer.shift(); bufferTs.shift(); }

  for (const fn of listeners) {
    try { fn(line); } catch { /* ignore closed connections */ }
  }
}

export function attachSseListener(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay today's buffer so the client sees history immediately
  const cutoff = Date.now() - BUFFER_TTL_MS;
  for (let i = 0; i < buffer.length; i++) {
    if ((bufferTs[i] ?? 0) >= cutoff) res.write(`data: ${buffer[i]}\n\n`);
  }

  const send = (line: string) => res.write(`data: ${line}\n\n`);
  listeners.add(send);

  // Keepalive comment every 25s to prevent proxy/browser timeouts
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); } }, 25_000);

  res.on('close', () => { listeners.delete(send); clearInterval(heartbeat); });
}
