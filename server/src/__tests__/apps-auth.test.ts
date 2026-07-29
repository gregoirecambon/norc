// App principals: key lifecycle (hash-at-rest, revocation), the /api/ext auth
// guard resolving both credential kinds, scope gating, and the access trail.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { runMigrations, db } from '../db/client.js';
import { agents, apps, appAccessLog } from '../db/schema.js';
import {
  generateAppKey, findAppByKey, appScopes, logAppAccess, recentAppAccess, pruneAppAccessLog,
  APP_KEY_PREFIX,
} from '../lib/apps.js';
import { extAuthGuard, extPrincipal, requireScope } from '../lib/ext-auth.js';
import { sha256 } from '../lib/user-auth.js';
import { eq } from 'drizzle-orm';

function addApp(id: string, name: string, key: string, opts: { scopes?: string[]; revokedAt?: number | null } = {}) {
  db.insert(apps).values({
    id, name,
    keyHash: sha256(key),
    keyPrefix: key.slice(0, APP_KEY_PREFIX.length + 8),
    scopes: JSON.stringify(opts.scopes ?? ['read', 'tasks:write']),
    createdAt: Date.now(),
    revokedAt: opts.revokedAt ?? null,
  }).run();
}

/** Minimal req/res doubles for the guard. */
function fakeReq(token: string | null, path = '/api/ext/agents'): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    originalUrl: path,
    method: 'GET',
    ip: '127.0.0.1',
  } as unknown as Request;
}

function fakeRes() {
  const finishHandlers: (() => void)[] = [];
  const state = { statusCode: 200, jsonBody: null as unknown };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(v: number) { state.statusCode = v; },
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.jsonBody = body; return res; },
    on(event: string, fn: () => void) { if (event === 'finish') finishHandlers.push(fn); },
    finish() { for (const fn of finishHandlers) fn(); },
  };
  return Object.assign(res, { state });
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  db.delete(appAccessLog).run();
  db.delete(apps).run();
  db.delete(agents).run();
});

describe('app key lifecycle', () => {
  it('generates prefixed keys and stores only the hash', () => {
    const { key, keyHash, keyPrefix } = generateAppKey();
    expect(key.startsWith(APP_KEY_PREFIX)).toBe(true);
    expect(key.length).toBe(APP_KEY_PREFIX.length + 48);
    expect(keyHash).toBe(sha256(key));
    expect(key.startsWith(keyPrefix)).toBe(true);
    expect(keyHash).not.toContain(key.slice(APP_KEY_PREFIX.length));
  });

  it('resolves a live key, rejects unknown and revoked keys', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key);
    expect(findAppByKey(key)?.name).toBe('n8n');
    expect(findAppByKey(APP_KEY_PREFIX + 'f'.repeat(48))).toBeNull();
    expect(findAppByKey('not-an-app-key')).toBeNull();

    db.update(apps).set({ revokedAt: Date.now() }).where(eq(apps.id, 'app1')).run();
    expect(findAppByKey(key)).toBeNull();
  });

  it('parses scopes defensively (malformed JSON, unknown scopes dropped)', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key, { scopes: ['read', 'nonsense', 'tasks:approve'] });
    const row = findAppByKey(key)!;
    expect(appScopes(row)).toEqual(['read', 'tasks:approve']);

    db.update(apps).set({ scopes: 'not json' }).where(eq(apps.id, 'app1')).run();
    expect(appScopes(findAppByKey(key)!)).toEqual([]);
  });
});

describe('extAuthGuard', () => {
  it('rejects a missing or unknown credential with 401', () => {
    let called = false;
    const res1 = fakeRes();
    extAuthGuard(fakeReq(null), res1 as unknown as Response, () => { called = true; });
    expect(res1.state.statusCode).toBe(401);

    const res2 = fakeRes();
    extAuthGuard(fakeReq(APP_KEY_PREFIX + 'a'.repeat(48)), res2 as unknown as Response, () => { called = true; });
    expect(res2.state.statusCode).toBe(401);
    expect(called).toBe(false);
  });

  it('resolves an app key to an app principal with its scopes', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key, { scopes: ['read'] });
    const req = fakeReq(key);
    const res = fakeRes();
    let principal: ReturnType<typeof extPrincipal> | null = null;
    extAuthGuard(req, res as unknown as Response, () => { principal = extPrincipal(req); });
    expect(principal).toMatchObject({ kind: 'app', name: 'n8n', scopes: ['read'] });
  });

  it('resolves an agentSecret to an agent principal with implicit scopes', () => {
    db.insert(agents).values({
      id: 'a1', name: 'alpha', adapterType: 'http', adapterConfig: '{}',
      agentSecret: 'secret-1', status: 'connected', registeredAt: Date.now(), metadata: '{}',
    }).run();
    const req = fakeReq('secret-1');
    const res = fakeRes();
    let principal: ReturnType<typeof extPrincipal> | null = null;
    extAuthGuard(req, res as unknown as Response, () => { principal = extPrincipal(req); });
    expect(principal).toMatchObject({ kind: 'agent', name: 'alpha', scopes: ['read', 'tasks:write'] });
  });

  it('logs app access on response finish and stamps lastUsedAt', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key);
    const req = fakeReq(key, '/api/ext/stats');
    const res = fakeRes();
    extAuthGuard(req, res as unknown as Response, () => { /* route ran */ });
    res.state.statusCode = 200;
    res.finish();

    const trail = recentAppAccess('app1');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ method: 'GET', path: '/api/ext/stats', status: 200, ip: '127.0.0.1' });
    expect(db.select().from(apps).where(eq(apps.id, 'app1')).all()[0]!.lastUsedAt).not.toBeNull();
  });

  it('requireScope gates by principal scopes', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key, { scopes: ['read'] });
    const req = fakeReq(key);
    const res = fakeRes();
    extAuthGuard(req, res as unknown as Response, () => { /* attached */ });

    let allowed = false;
    requireScope('read')(req, res as unknown as Response, () => { allowed = true; });
    expect(allowed).toBe(true);

    const res403 = fakeRes();
    let denied = true;
    requireScope('tasks:approve')(req, res403 as unknown as Response, () => { denied = false; });
    expect(denied).toBe(true);
    expect(res403.state.statusCode).toBe(403);
  });
});

describe('access log pruning', () => {
  it('drops rows older than the retention window, keeps fresh ones', () => {
    const { key } = generateAppKey();
    addApp('app1', 'n8n', key);
    logAppAccess('app1', 'GET', '/api/ext/me', 200, null);
    db.insert(appAccessLog).values({
      id: 'old', appId: 'app1', method: 'GET', path: '/x', status: 200, ip: null,
      at: Date.now() - 91 * 24 * 3600_000,
    }).run();
    expect(pruneAppAccessLog()).toBe(1);
    expect(recentAppAccess('app1')).toHaveLength(1);
  });
});
