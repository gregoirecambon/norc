// Single source of truth for NORC's public base URL (agent-facing links, skill
// downloads, webhook registration). Other URL fallbacks are intentionally
// different and must NOT be unified here: lib/oauth.ts and routes/team.ts fall
// back to the UI dev port 3000, routes/auth.ts treats "unset" as null, and
// lib/user-auth.ts only checks the https scheme.
export function norcBaseUrl(): string {
  return process.env['NORC_PUBLIC_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3001}`;
}
