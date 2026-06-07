import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emitLog } from './logger.js';

// Update checker: compares the running version (server/package.json) against
// the latest GitHub release (falling back to tags). Re-checks every 6h with a
// last-good-value cache so transient API failures never blank the badge.

const REPO = 'gregoirecambon/norc';
const CHECK_INTERVAL_MS = 6 * 3600_000;

let currentVersion: string | null = null;

/**
 * The running version. `../../package.json` relative to this module resolves
 * to server/package.json in dev (src/lib/) and /app/package.json in the Docker
 * image (dist/lib/) — the Dockerfile copies it there.
 */
export function getCurrentVersion(): string {
  if (currentVersion) return currentVersion;
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    currentVersion = pkg.version ?? '0.0.0';
  } catch {
    currentVersion = '0.0.0';
  }
  return currentVersion;
}

const cache: { latest: string | null; url: string | null; checkedAt: number } = {
  latest: null,
  url: null,
  checkedAt: 0,
};

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'norc',
  };
  const token = (process.env['GITHUB_TOKEN'] ?? '').trim();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Compare dotted versions numerically (leading 'v' stripped). >0 when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Fetch the latest release (or newest tag) from GitHub. Keeps the last good value on failure. */
export async function checkLatest(): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: githubHeaders() });
    if (res.ok) {
      const body = await res.json() as { tag_name?: string; html_url?: string };
      if (body.tag_name) {
        cache.latest = body.tag_name;
        cache.url = body.html_url ?? `https://github.com/${REPO}/releases`;
        cache.checkedAt = Date.now();
        return;
      }
    }
    // No releases yet — fall back to the newest tag.
    if (res.status === 404) {
      const tagsRes = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=1`, { headers: githubHeaders() });
      if (tagsRes.ok) {
        const tags = await tagsRes.json() as { name: string }[];
        if (tags[0]?.name) {
          cache.latest = tags[0].name;
          cache.url = `https://github.com/${REPO}/releases`;
          cache.checkedAt = Date.now();
        }
      }
    }
  } catch {
    // network failure — keep the last good value
  }
}

export function getVersionInfo(): { current: string; latest: string | null; updateAvailable: boolean; url: string | null } {
  const current = getCurrentVersion();
  return {
    current,
    latest: cache.latest,
    updateAvailable: !!cache.latest && compareVersions(cache.latest, current) > 0,
    url: cache.url,
  };
}

/** Self-rescheduling update check (same pattern as heartbeatLoop). */
export async function startVersionLoop(): Promise<void> {
  await checkLatest();
  const info = getVersionInfo();
  if (info.updateAvailable) {
    emitLog(`update available: ${info.latest} (running v${info.current})`);
  }
  setTimeout(() => { void startVersionLoop(); }, CHECK_INTERVAL_MS);
}
