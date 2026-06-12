// The durable NORC agent skill — the orchestration protocol agents download on
// join and refresh on update. Bump NORC_SKILL_VERSION whenever SKILL.md changes
// so the "Update skills" flow has something meaningful to advertise.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NORC_SKILL_VERSION = 14;

// Vendored inside the server package (server/skills/…) so it ships in the Docker
// image — the build context is ./server, so a repo-root path wouldn't be present.
// '../../skills/…' resolves the same from src/lib (dev) and dist/lib (built).
const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills/agent/SKILL.md',
);

/** Read the skill markdown, templated with the live NORC URL + version. */
export function readSkillDoc(norcUrl: string): string {
  return readFileSync(SKILL_PATH, 'utf8')
    .replace(/{{NORC_URL}}/g, norcUrl)
    .replace(/{{VERSION}}/g, String(NORC_SKILL_VERSION));
}
