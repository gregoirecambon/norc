// Forcing a chore + input substitution — pure text helpers, no I/O.
//
// A user forces a chore by naming it in a task's title/body with `/chore <id>` or
// `[[chore:<id>]]`. Detection is deterministic and fires ONLY when the token equals
// a known chore id (so a stray "/chore foo" with no matching chore is ignored, not
// guessed). Optional `key=value` / `key="two words"` pairs after the token seed inputs.

export interface ForcedChore { id: string; inputs: Record<string, string> }

const TOKEN_RE = /(?:^|\s)(?:\/chore\s+|\[\[chore:)\s*([a-z0-9][\w-]*)\]?\]?(.*)$/im;
const PAIR_RE = /([A-Za-z0-9_]+)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

/** Detect a forced chore reference whose id is in `choreIds`. Returns null otherwise. */
export function detectForcedChore(text: string, choreIds: string[]): ForcedChore | null {
  if (!text) return null;
  const known = new Set(choreIds.map(id => id.toLowerCase()));
  // Scan each line so the trailing capture doesn't swallow the whole document.
  for (const line of text.split(/\r?\n/)) {
    const m = TOKEN_RE.exec(line);
    if (!m) continue;
    const id = m[1]!;
    if (!known.has(id.toLowerCase())) continue;
    const canonical = choreIds.find(c => c.toLowerCase() === id.toLowerCase())!;
    const inputs: Record<string, string> = {};
    const rest = m[2] ?? '';
    let pair: RegExpExecArray | null;
    PAIR_RE.lastIndex = 0;
    while ((pair = PAIR_RE.exec(rest)) !== null) {
      inputs[pair[1]!] = pair[2]!.replace(/^["']|["']$/g, '');
    }
    return { id: canonical, inputs };
  }
  return null;
}

/** Replace {name} placeholders with input values. Unknown placeholders are left
 * intact and reported so the caller can surface "missing input" instead of shipping
 * a half-templated task. */
export function substituteInputs(
  text: string,
  inputs: Record<string, string>,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    if (name in inputs && inputs[name] !== undefined && inputs[name] !== '') return inputs[name]!;
    missing.add(name);
    return whole;
  });
  return { text: out, missing: [...missing] };
}
