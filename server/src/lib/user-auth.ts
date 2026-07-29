import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

export type SessionUser = typeof users.$inferSelect;
export type Role = 'owner' | 'admin' | 'member';

export const SESSION_COOKIE = 'norc_session';
const SESSION_TTL_MS = 30 * 24 * 3600_000;       // 30 days
const RENEW_BELOW_MS = 15 * 24 * 3600_000;       // sliding renewal once under 15 days left
const LAST_SEEN_THROTTLE_MS = 60_000;            // write last_seen_at at most ~once/min

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function parseCookies(req: Request): Record<string, string> {
  const header = (req.headers['cookie'] ?? '').toString();
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Whether session cookies should carry the Secure flag. Auto-derived from
 * NORC_PUBLIC_URL (https → Secure); COOKIE_SECURE=0/1 overrides for plain-http
 * LAN installs or forced-secure setups.
 */
function cookieSecure(): boolean {
  const override = process.env['COOKIE_SECURE'];
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;
  return (process.env['NORC_PUBLIC_URL'] ?? '').startsWith('https://');
}

export function setSessionCookie(res: Response, token: string): void {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (cookieSecure()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/** Short-lived cookie holding the OAuth CSRF state (optionally `state.inviteToken`). */
export const OAUTH_STATE_COOKIE = 'norc_oauth_state';

export function setOauthStateCookie(res: Response, value: string): void {
  const attrs = [`${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=600'];
  if (cookieSecure()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearOauthStateCookie(res: Response): void {
  res.append('Set-Cookie', `${OAUTH_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function createSession(userId: string, userAgent?: string): { token: string; expiresAt: number } {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.insert(sessions).values({
    id: randomUUID(),
    tokenHash: sha256(token),
    userId,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: userAgent?.slice(0, 256) ?? null,
  }).run();
  return { token, expiresAt };
}

/**
 * Resolve the session cookie to its user. Renews the expiry (sliding window)
 * and stamps last_seen_at, both throttled so reads don't write on every request.
 */
export function getSessionUser(req: Request): SessionUser | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const now = Date.now();
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token))).all()[0];
  if (!session || session.expiresAt <= now) return null;
  const user = db.select().from(users).where(eq(users.id, session.userId)).all()[0];
  if (!user) return null;

  if ((session.lastSeenAt ?? 0) + LAST_SEEN_THROTTLE_MS < now) {
    const patch: { lastSeenAt: number; expiresAt?: number } = { lastSeenAt: now };
    if (session.expiresAt - now < RENEW_BELOW_MS) patch.expiresAt = now + SESSION_TTL_MS;
    db.update(sessions).set(patch).where(eq(sessions.id, session.id)).run();
  }
  return user;
}

export function destroySession(req: Request): void {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return;
  db.delete(sessions).where(eq(sessions.tokenHash, sha256(token))).run();
}

export function pruneExpiredSessions(): void {
  try {
    db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// API guard
//
// Every /api route requires a dashboard session EXCEPT the entries below —
// each of which carries its own credential, verified inside its route
// (registration token, handshake nonce, run token, agentSecret). Allowlisting
// here opens nothing: it only delegates auth back to the route. This is the
// single place agent/public exemptions live — keep it that way.
// ---------------------------------------------------------------------------

const PUBLIC_API: { method: string; test: (p: string) => boolean }[] = [
  // Agent self-registration — consumes a one-time registration token.
  { method: 'POST', test: p => p === '/api/agents/register' },
  // Handshake completion — the agent posts back the nonce it was challenged with.
  { method: 'POST', test: p => /^\/api\/handshakes\/[^/]+\/complete$/.test(p) },
  // Run-scoped Agent API — every route resolves the opaque run token in the path.
  { method: '*', test: p => p.startsWith('/api/runs/') },
  // Agent identity routes — assertAgentAuth (Bearer agentSecret) inside.
  { method: '*', test: p => p === '/api/me' || p.startsWith('/api/me/') },
  // Machine surface — extAuthGuard (Bearer agentSecret or app key) inside.
  { method: '*', test: p => p.startsWith('/api/ext/') },
  // Protocol doc — agents re-fetch it autonomously.
  { method: 'GET', test: p => p === '/api/skill' || p === '/api/skill/version' },
  // Worker bundle — the copy-paste invite downloads this before it has any credentials.
  { method: 'GET', test: p => p === '/api/worker' },
  // Public feedback form — the link humans click from Slack/email. Lives under
  // /api so every install's proxy already forwards it (a bare /feedback path
  // falls through to the SPA on nginx installs that predate the location
  // block). The 7-day invite token in the path is the credential; the route
  // itself additionally enforces the feedbackFormRequiresLogin setting.
  { method: '*', test: p => p.startsWith('/api/feedback/form/') },
  // Public health check (login page reachability + container healthchecks).
  { method: 'GET', test: p => p === '/api/health' },
  // The auth flow itself.
  { method: '*', test: p => p.startsWith('/api/auth/') },
];

/** The session user attached by apiAuthGuard. Only call on guarded routes. */
export function requestUser(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

export function apiAuthGuard(req: Request, res: Response, next: NextFunction): void {
  // req.path is relative to the mount point ('/api'), so test the full originalUrl path.
  const path = (req.originalUrl.split('?')[0] ?? '');
  for (const rule of PUBLIC_API) {
    if ((rule.method === '*' || rule.method === req.method) && rule.test(path)) {
      next();
      return;
    }
  }
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  (req as Request & { user: SessionUser }).user = user;
  next();
}

/** Per-route role gate for team management. Use after apiAuthGuard populated the user. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = requestUser(req)?.role as Role | undefined;
    if (!role || !roles.includes(role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
