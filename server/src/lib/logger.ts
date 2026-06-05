import type { Response } from 'express';
import { lt, gte, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logs } from '../db/schema.js';

// Logs are persisted to SQLite so they survive page refreshes and server
// restarts. Retention is purely age-based: entries older than 24h are pruned,
// everything newer is kept (and replayed to any client that (re)connects).
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const PRUNE_EVERY = 200; // amortize pruning across roughly every N writes

interface LogEntry { ts: number; line: string }

const listeners = new Set<(entry: LogEntry) => void>();
const clearers = new Set<() => void>();
let writesSincePrune = 0;

/** Delete log entries older than the retention window. Best-effort. */
export function pruneOldLogs(): void {
  try {
    db.delete(logs).where(lt(logs.ts, Date.now() - RETENTION_MS)).run();
  } catch {
    // best-effort — never let pruning break anything
  }
}

/** Wipe all persisted logs and tell every connected viewer to clear. */
export function clearLogs(): void {
  try {
    db.delete(logs).run();
  } catch {
    // best-effort
  }
  for (const c of clearers) {
    try { c(); } catch { /* ignore closed connections */ }
  }
}

export function emitLog(message: string) {
  const ts = Date.now();
  const line = `[norc ${new Date(ts).toISOString().slice(11, 19)}] ${message}`;
  process.stdout.write(line + '\n');

  // Persist (best-effort: logging must never throw, e.g. before migrations run).
  try {
    db.insert(logs).values({ ts, line }).run();
    if (++writesSincePrune >= PRUNE_EVERY) {
      writesSincePrune = 0;
      pruneOldLogs();
    }
  } catch {
    // ignore persistence failures
  }

  for (const fn of listeners) {
    try { fn({ ts, line }); } catch { /* ignore closed connections */ }
  }
}

export function attachSseListener(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Each SSE message is a JSON object { ts, line } so the client can compute
  // accurate relative times (e.g. "5 min ago") for replayed history too.
  const send = (entry: LogEntry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);

  // Replay the last 24h from durable storage so a refresh/restart keeps history.
  pruneOldLogs();
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const history = db.select().from(logs)
      .where(gte(logs.ts, cutoff))
      .orderBy(asc(logs.id))
      .all();
    for (const row of history) send({ ts: row.ts, line: row.line });
  } catch {
    // no history available yet — stream live only
  }

  listeners.add(send);

  // A dedicated SSE event so a "Clear" from any client resets all viewers live.
  const clear = () => res.write('event: clear\ndata: {}\n\n');
  clearers.add(clear);

  // Keepalive comment every 25s to prevent proxy/browser timeouts
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); } }, 25_000);

  res.on('close', () => { listeners.delete(send); clearers.delete(clear); clearInterval(heartbeat); });
}
