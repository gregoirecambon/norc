// The API reference exists twice on purpose: server/assets/API.md ships in the
// Docker image (build context is ./server, so a repo-root path wouldn't be
// present) and docs/API.md is the shareable GitHub copy. This test is the
// drift guard: edit one, regenerate the other
// (sed 's|{{NORC_URL}}|https://your-norc-url|g' server/assets/API.md > docs/API.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const served = path.join(here, '../../assets/API.md');
const repo = path.join(here, '../../../docs/API.md');

describe('API doc copies', () => {
  it('docs/API.md matches server/assets/API.md (modulo the URL placeholder)', () => {
    const normalized = readFileSync(served, 'utf8').replace(/{{NORC_URL}}/g, 'https://your-norc-url');
    expect(readFileSync(repo, 'utf8')).toBe(normalized);
  });

  it('the served copy still templates the live URL', () => {
    expect(readFileSync(served, 'utf8')).toContain('{{NORC_URL}}');
  });
});
