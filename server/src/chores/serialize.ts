// Canonical chore.md serializer — the inverse of parseChore. Used by the Notion
// mirror so disk and Notion can be compared by a STABLE content hash (raw-byte
// hashing would false-diff on whitespace a Notion round-trip drops). The body the
// mirror stores in Notion is exactly serializeChore(doc).

import { createHash } from 'node:crypto';
import type { ChoreDoc } from './types.js';

/** Serialize a parsed chore back to canonical chore.md text (parseChore-readable). */
export function serializeChore(doc: ChoreDoc): string {
  const front = [
    '---',
    `chore: ${doc.id}`,
    `description: ${doc.description}`,
    `trigger: ${doc.trigger}`,
    `inputs: [${doc.inputs.join(', ')}]`,
    `binding: ${doc.binding}`,
    `approval: ${doc.approval}`,
    `min_confidence: ${doc.minConfidence}`,
    '---',
  ].join('\n');

  const steps = doc.steps.map(s => {
    const lines = [`### ${s.number}. ${s.title}`.trimEnd()];
    lines.push(`needs: ${s.needs}`);
    lines.push(`do: ${s.do}`);
    if (s.returns) lines.push(`returns: ${s.returns}`);
    if (s.after.length) lines.push(`after: [${s.after.map(i => doc.steps[i]?.number ?? i + 1).join(', ')}]`);
    if (s.gate) lines.push(`gate: ${s.gate}`);
    return lines.join('\n');
  });

  return `${front}\n\n${steps.join('\n\n')}\n`;
}

/** Stable content hash of a chore (canonical form), for sync diffing. */
export function choreContentHash(doc: ChoreDoc): string {
  return createHash('sha256').update(serializeChore(doc)).digest('hex').slice(0, 16);
}
