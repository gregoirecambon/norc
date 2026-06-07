// Task title similarity — the heuristic half of the out-of-band duplicate
// check. PURE (no I/O, no DB): tokenize titles, score overlap, and surface the
// candidates worth blocking on (or worth showing the LLM judge). The semantic
// half lives in orchestrator-agent.ts (judgeTaskSimilarity); external-tasks.ts
// combines the two.

/** Words too common to signal similarity on their own (EN + FR). */
const STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'with',
  'into', 'from', 'by', 'is', 'be', 'this', 'that', 'it', 'as', 'our', 'new',
  // French
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'pour',
  'sur', 'dans', 'avec', 'au', 'aux', 'ce', 'cette', 'en', 'par',
]);

/** Lowercase, strip diacritics + punctuation, split, drop stopwords. */
export function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks: é → e, etc.
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Similarity in [0, 1] between two titles: max of token Jaccard and
 * containment (|A∩B| / min size — catches "Fix login bug" ⊂ "Fix the login
 * bug on iOS"). Empty token sets score 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  const jaccard = common / (ta.size + tb.size - common);
  const containment = common / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

/** Normalized form for exact-duplicate detection (token-order independent). */
export function normalizedTitle(title: string): string {
  return tokenize(title).sort().join(' ');
}

export interface SimilarityCandidate<T> {
  task: T;
  score: number;
  /** Strong enough to block creation on the heuristic alone. */
  blocking: boolean;
}

export interface HeuristicOptions {
  /** Score at or above which the heuristic alone blocks creation. */
  blockAt?: number;
  /** Score at or above which a candidate is worth showing the LLM judge. */
  judgeAt?: number;
  /** Max candidates returned (best first). */
  max?: number;
}

/**
 * Score `title` against existing tasks and return the candidates worth
 * considering (score ≥ judgeAt), best first. An exact normalized-title match
 * always blocks, whatever the thresholds.
 */
export function heuristicCandidates<T>(
  title: string,
  tasks: T[],
  getTitle: (t: T) => string,
  opts: HeuristicOptions = {},
): SimilarityCandidate<T>[] {
  const { blockAt = 0.5, judgeAt = 0.35, max = 8 } = opts;
  const norm = normalizedTitle(title);
  const scored: SimilarityCandidate<T>[] = [];
  for (const task of tasks) {
    const other = getTitle(task);
    const score = titleSimilarity(title, other);
    const exact = norm.length > 0 && normalizedTitle(other) === norm;
    if (exact || score >= judgeAt) {
      scored.push({ task, score: exact ? 1 : score, blocking: exact || score >= blockAt });
    }
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, max);
}
