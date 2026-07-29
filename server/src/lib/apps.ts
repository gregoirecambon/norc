// App principals — non-AI API clients (n8n flows, custom services…) that hold
// a static key to NORC's /api/ext surface. A key looks like
// 'norc_app_<48 hex>'; only its sha256 lands in the DB, so a leaked database
// never leaks live keys. The dashboard shows keyPrefix afterwards for
// recognition, never the key itself.

import { randomBytes, randomUUID } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apps, appAccessLog } from '../db/schema.js';
import { sha256 } from './user-auth.js';

export type AppRow = typeof apps.$inferSelect;

export const APP_KEY_PREFIX = 'norc_app_';
export const APP_SCOPES = ['read', 'tasks:write', 'tasks:approve'] as const;
export type AppScope = (typeof APP_SCOPES)[number];

const ACCESS_LOG_RETENTION_MS = 90 * 24 * 3600_000;

export function generateAppKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = APP_KEY_PREFIX + randomBytes(24).toString('hex');
  return { key, keyHash: sha256(key), keyPrefix: key.slice(0, APP_KEY_PREFIX.length + 8) };
}

/** Resolve a presented key to a live (non-revoked) app row. */
export function findAppByKey(key: string): AppRow | null {
  if (!key.startsWith(APP_KEY_PREFIX)) return null;
  const row = db.select().from(apps).where(eq(apps.keyHash, sha256(key))).all()[0];
  return row && !row.revokedAt ? row : null;
}

export function appScopes(row: AppRow): AppScope[] {
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) return parsed.filter((s): s is AppScope => (APP_SCOPES as readonly string[]).includes(s));
  } catch { /* malformed → no scopes */ }
  return [];
}

/** One access-trail row per authenticated /api/ext request (called on response finish). */
export function logAppAccess(appId: string, method: string, path: string, status: number, ip: string | null): void {
  const now = Date.now();
  try {
    db.insert(appAccessLog).values({ id: randomUUID(), appId, method, path: path.slice(0, 200), status, ip, at: now }).run();
    db.update(apps).set({ lastUsedAt: now }).where(eq(apps.id, appId)).run();
  } catch { /* best-effort — auditing must never fail the request */ }
}

export function pruneAppAccessLog(): number {
  return db.delete(appAccessLog).where(lt(appAccessLog.at, Date.now() - ACCESS_LOG_RETENTION_MS)).run().changes;
}

/** Recent access rows for the dashboard's per-app audit view. */
export function recentAppAccess(appId: string, limit = 100): (typeof appAccessLog.$inferSelect)[] {
  return db.select().from(appAccessLog)
    .where(eq(appAccessLog.appId, appId))
    .orderBy(sql`${appAccessLog.at} DESC`)
    .limit(Math.min(Math.max(limit, 1), 500))
    .all();
}
