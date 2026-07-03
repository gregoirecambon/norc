import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const dbPath = process.env['DATABASE_PATH'] ?? './norc.db';
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

// Journal timestamps must stay MONOTONIC: drizzle applies a migration only when
// its journal `when` exceeds the ledger's max created_at. Entries 0031/0032 were
// hand-journaled with timestamps up to 1783600000000 (2026-07-09) — so a
// freshly generated `when` (wall-clock) sorts BELOW them until that date and
// the migration is silently skipped on upgrading installs. That skipped 0033 on
// v0.13/v0.14 → v0.15.0 upgrades. 0033/0034 are re-journaled above the range;
// keep bumping past the previous entry for anything generated before 2026-07-12.
const REJOURNALED_0033_WHEN = 1783700000000;

/** Installs that already ran 0033 under its ORIGINAL timestamp (fresh v0.15.0
 * DBs) have a ledger max of 1783600000000 — re-journaling 0033 above that
 * would make drizzle apply it AGAIN (CREATE TABLE collision). Mark it applied
 * under the new timestamp first. Presence of feedback_invites is the proof. */
function repairMigrationLedger(): void {
  const ledger = sqlite.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`).get();
  if (!ledger) return; // fresh DB — everything applies in order
  const applied0033 = sqlite.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_invites'`).get();
  if (!applied0033) return; // 0033 pending — it will apply under its new timestamp
  const { m } = sqlite.prepare(
    `SELECT MAX(CAST(created_at AS INTEGER)) AS m FROM __drizzle_migrations`).get() as { m: number | null };
  if ((m ?? 0) >= REJOURNALED_0033_WHEN) return; // already marked
  const sql = readFileSync(path.join(migrationsFolder, '0033_feedback_stats.sql')).toString();
  sqlite.prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
    .run(createHash('sha256').update(sql).digest('hex'), REJOURNALED_0033_WHEN);
}

export function runMigrations() {
  repairMigrationLedger();
  migrate(db, { migrationsFolder });
}

/** Close the SQLite handle on shutdown so the WAL checkpoints cleanly. */
export function closeDb(): void {
  sqlite.close();
}
