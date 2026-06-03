import type { Response } from 'express';

const listeners = new Set<(line: string) => void>();

export function emitLog(message: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[norc ${ts}] ${message}`;
  process.stdout.write(line + '\n');
  for (const fn of listeners) {
    try { fn(line); } catch { /* ignore closed connections */ }
  }
}

export function attachSseListener(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (line: string) => res.write(`data: ${line}\n\n`);
  listeners.add(send);

  res.on('close', () => listeners.delete(send));
}
