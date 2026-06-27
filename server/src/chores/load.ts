// Disk loader for chore.md files + the cheap triage index. Mirrors lib/skill.ts:
// chores live under server/chores/<name>/CHORE.md so they ship in the Docker image
// (build context is ./server) and can carry companion assets later. Parsed results
// are cached by a directory signature (filenames + mtimes) so the triage hot path —
// which fires in bursts — does no repeated file I/O; the cache rebuilds when a file
// changes. A file that fails to parse is logged and skipped, never fatal.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitLog } from '../lib/logger.js';
import { parseChore } from './parse.js';
import type { ChoreDoc, ChoreIndexEntry } from './types.js';

// Bump when the chore format/serving changes (parallels NORC_SKILL_VERSION).
export const CHORES_VERSION = 1;

// '../../chores' resolves the same from src/chores (dev) and dist/chores (built).
export const CHORES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../chores');

const CACHE_TTL_MS = 5_000;
let cache: { sig: string; at: number; chores: ChoreDoc[] } | null = null;

/** Cheap signature of the chores dir: each CHORE.md's path + mtime + size. Changes
 * whenever a file is added, removed, or edited → cache invalidates. */
function dirSignature(): string {
  if (!existsSync(CHORES_DIR)) return 'none';
  const parts: string[] = [];
  for (const entry of readdirSync(CHORES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(CHORES_DIR, entry.name, 'CHORE.md');
    try {
      const st = statSync(file);
      parts.push(`${entry.name}:${st.mtimeMs}:${st.size}`);
    } catch { /* no CHORE.md in this subdir */ }
  }
  return parts.sort().join('|') || 'empty';
}

/** Load + parse every chore on disk (cached). Invalid files are skipped. */
export function loadChores(): ChoreDoc[] {
  const sig = dirSignature();
  const now = Date.now();
  if (cache && cache.sig === sig && now - cache.at < CACHE_TTL_MS) return cache.chores;
  if (cache && cache.sig === sig) { cache.at = now; return cache.chores; }

  const chores: ChoreDoc[] = [];
  if (existsSync(CHORES_DIR)) {
    for (const entry of readdirSync(CHORES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(CHORES_DIR, entry.name, 'CHORE.md');
      let raw: string;
      try { raw = readFileSync(file, 'utf8'); } catch { continue; }
      try {
        const doc = parseChore(raw);
        if (chores.some(c => c.id === doc.id)) {
          emitLog(`chore "${doc.id}" (${entry.name}/CHORE.md) duplicates an earlier id — skipped`, 'NORC');
          continue;
        }
        chores.push(doc);
      } catch (err) {
        emitLog(`chore ${entry.name}/CHORE.md failed to parse: ${err instanceof Error ? err.message : 'error'}`, 'NORC');
      }
    }
  }
  cache = { sig, at: now, chores };
  return chores;
}

/** The description-only index triage reads to decide if a task matches a process. */
export function buildChoreIndex(chores: ChoreDoc[] = loadChores()): ChoreIndexEntry[] {
  return chores.map(c => ({ id: c.id, description: c.description }));
}

/** Look up one chore by id (case-insensitive). */
export function getChore(id: string): ChoreDoc | null {
  const norm = id.trim().toLowerCase();
  return loadChores().find(c => c.id.toLowerCase() === norm) ?? null;
}
