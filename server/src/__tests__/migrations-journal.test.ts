import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Drizzle's migrator applies a migration only when its journal `when` exceeds
// the ledger's max created_at — an entry journaled at or below any earlier one
// is SILENTLY skipped on upgrading installs. That skipped 0033 on v0.14→v0.15.0
// and crash-looped production (missing feedback_* schema). This is the guard
// the incident report asked for: `pnpm db:generate` stamps wall-clock `when`
// values, which sort below the hand-picked 17835–1783800000000 range until
// 2026-07-12 — bump new entries above the previous one by hand until then.

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

interface Journal { entries: { idx: number; when: number; tag: string }[] }
const journal = JSON.parse(
  readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8'),
) as Journal;

describe('migration journal', () => {
  it('has strictly increasing `when` timestamps (drizzle skips out-of-order entries)', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const cur = journal.entries[i]!;
      expect(
        cur.when,
        `journal entry "${cur.tag}" (when=${cur.when}) must exceed "${prev.tag}" (when=${prev.when}) — ` +
        'drizzle would silently never apply it on upgrading installs',
      ).toBeGreaterThan(prev.when);
    }
  });

  it('has strictly increasing idx values matching entry order', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx).toBeGreaterThan(journal.entries[i - 1]!.idx);
    }
  });

  it('has a .sql file for every entry', () => {
    for (const entry of journal.entries) {
      expect(
        existsSync(path.join(migrationsDir, `${entry.tag}.sql`)),
        `journal entry "${entry.tag}" has no matching .sql file`,
      ).toBe(true);
    }
  });
});
