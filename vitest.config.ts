import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/src/**/*.test.ts'],
    // Server modules open a SQLite handle on import; keep it in-memory under test
    // so importing them never touches or creates an on-disk dev database.
    env: { DATABASE_PATH: ':memory:' },
  },
});
