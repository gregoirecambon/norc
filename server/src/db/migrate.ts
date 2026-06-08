// Standalone migration runner: applies all pending Drizzle migrations against the
// configured database, then exits. Migrations also auto-apply on server boot via
// runMigrations() in index.ts — this script (pnpm db:migrate) is for deploy/CI
// pipelines or manual runs where you want migrations applied without booting the
// server. Loads the same root .env the server uses so DATABASE_PATH matches.
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenvConfig({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.env'), override: true });

// Dynamic import AFTER dotenv so client.ts reads DATABASE_PATH from .env, not the
// (hoisted) pre-dotenv environment.
void (async () => {
  try {
    const { runMigrations } = await import('./client.js');
    runMigrations();
    console.log('✓ migrations applied');
    process.exit(0);
  } catch (err) {
    console.error('✗ migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
