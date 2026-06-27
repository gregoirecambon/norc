// Pure chore.md parser: a tiny `---` frontmatter splitter + numbered-step reader,
// validated with zod. No YAML dependency (the repo has none). Exported pure so the
// prompt/format shape is unit-testable without disk or an LLM. A malformed file
// throws — loadChores() catches and skips it (best-effort), never half-parses.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChoreDoc, ChoreStep } from './types.js';

/** Strip a trailing inline comment (2+ spaces then #) — used for scalar fields so
 * `trigger: mention   # a | b | c` reads as `mention`. Prose fields keep their #. */
function stripComment(s: string): string {
  return s.replace(/\s{2,}#.*$/, '').trim();
}

/** Split a `---`-fenced frontmatter block from the body. Throws if absent. */
function splitFrontmatter(raw: string): { front: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('missing --- frontmatter block');
  return { front: m[1] ?? '', body: m[2] ?? '' };
}

/** Parse the simple `key: value` frontmatter. Supports inline lists `[a, b]`. */
function parseFrontmatter(front: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rawVal = stripComment(m[2] ?? '');
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      out[key] = rawVal.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      out[key] = rawVal;
    }
  }
  return out;
}

const STEP_FIELDS = new Set(['needs', 'do', 'returns', 'after', 'gate']);

/** Parse the numbered body steps. Each step starts at a `### N. Title` heading; its
 * fields (`needs:`/`do:`/`returns:`/`after:`/`gate:`) follow, each able to span
 * multiple lines until the next field or heading. */
function parseSteps(body: string): ChoreStep[] {
  const lines = body.split(/\r?\n/);
  const steps: ChoreStep[] = [];
  let cur: { number: number; title: string; fields: Record<string, string> } | null = null;
  let field: string | null = null;

  const flush = () => {
    if (!cur) return;
    const f = cur.fields;
    steps.push({
      index: steps.length,
      number: cur.number,
      title: cur.title,
      needs: (f['needs'] ?? '').trim(),
      do: (f['do'] ?? '').trim(),
      returns: f['returns']?.trim() || undefined,
      after: [], // resolved after all steps are known (1-based numbers → 0-based indices)
      gate: f['gate']?.trim() || undefined,
      // stash the raw `after` text on a side channel via the title? No — keep in fields.
    });
    // carry the raw after text so the caller can resolve indices
    (steps[steps.length - 1] as ChoreStep & { _after?: string })._after = f['after']?.trim();
  };

  for (const line of lines) {
    const heading = /^#{1,6}\s*(\d+)[.)]?\s*(.*)$/.exec(line);
    if (heading) {
      flush();
      cur = { number: Number(heading[1]), title: stripComment(heading[2] ?? ''), fields: {} };
      field = null;
      continue;
    }
    if (!cur) continue;
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    if (kv && STEP_FIELDS.has(kv[1]!.toLowerCase())) {
      field = kv[1]!.toLowerCase();
      cur.fields[field] = stripComment(kv[2] ?? '');
    } else if (field && line.trim()) {
      cur.fields[field] = `${cur.fields[field] ?? ''} ${line.trim()}`.trim();
    }
  }
  flush();

  // Resolve `after`: file numbers are 1-based; map each to the array index of the
  // step with that `number`, and require it to come earlier (DAG by construction).
  const numberToIndex = new Map(steps.map(s => [s.number, s.index]));
  for (const s of steps) {
    const rawAfter = (s as ChoreStep & { _after?: string })._after;
    delete (s as ChoreStep & { _after?: string })._after;
    if (!rawAfter) continue;
    const refs = rawAfter.replace(/[[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean);
    for (const r of refs) {
      const n = Number(r);
      if (!Number.isFinite(n)) throw new Error(`step ${s.number}: non-numeric "after" value "${r}"`);
      const idx = numberToIndex.get(n);
      if (idx === undefined) throw new Error(`step ${s.number}: "after" references unknown step ${n}`);
      if (idx >= s.index) throw new Error(`step ${s.number}: "after" must reference an earlier step (got ${n})`);
      s.after.push(idx);
    }
  }
  return steps;
}

const frontSchema = z.object({
  chore: z.string().min(1),
  description: z.string().min(1),
  trigger: z.enum(['mention', 'status-change', 'scheduled']).default('mention'),
  inputs: z.array(z.string()).default([]),
  binding: z.literal('plan-time').default('plan-time'),
  approval: z.enum(['auto', 'cast']).default('cast'),
  min_confidence: z.coerce.number().min(0).max(1).default(0.6),
});

/** Parse a chore.md string into a validated ChoreDoc. Throws on malformed input. */
export function parseChore(raw: string): ChoreDoc {
  const { front, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(front);
  const parsed = frontSchema.parse({
    chore: fm['chore'],
    description: fm['description'],
    trigger: fm['trigger'],
    inputs: Array.isArray(fm['inputs']) ? fm['inputs'] : (fm['inputs'] ? [String(fm['inputs'])] : []),
    binding: fm['binding'],
    approval: fm['approval'],
    min_confidence: fm['min_confidence'],
  });

  const steps = parseSteps(body);
  if (steps.length === 0) throw new Error('chore has no steps');
  for (const s of steps) {
    if (!s.needs) throw new Error(`step ${s.number} ("${s.title}") is missing "needs:"`);
    if (!s.do) throw new Error(`step ${s.number} ("${s.title}") is missing "do:"`);
  }

  return {
    id: parsed.chore,
    description: parsed.description,
    trigger: parsed.trigger,
    inputs: parsed.inputs,
    binding: 'plan-time',
    approval: parsed.approval,
    minConfidence: parsed.min_confidence,
    steps,
    hash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    raw,
  };
}
