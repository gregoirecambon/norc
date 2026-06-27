// Shared types for the chores module. A "chore" is a reusable, multi-step
// process definition (chore.md) that triage can select (or a human can force),
// then compile into a DAG of pre-assigned Notion tasks.

export type ChoreTrigger = 'mention' | 'status-change' | 'scheduled';
export type ChoreApproval = 'auto' | 'cast';

/** One step of a chore. `after` holds the 0-based array indices of earlier steps
 * this one depends on (converted from the 1-based numbers written in the file),
 * so it maps straight onto proposeTasks' `dependsOn` batch-index contract. */
export interface ChoreStep {
  index: number;       // 0-based position in the body
  number: number;      // 1-based step number as written ("### 2. …" → 2)
  title: string;       // short label from the heading
  needs: string;       // capability phrase → per-step triage input
  do: string;          // task instruction (may contain {input} placeholders)
  returns?: string;    // output contract — appended to the task body
  after: number[];     // 0-based indices of prerequisite steps → dependsOn
  gate?: string;       // P3 only — parsed but ignored in v1
}

export interface ChoreDoc {
  id: string;          // frontmatter `chore` — the stable id
  description: string; // the ONLY thing triage reads in the index
  trigger: ChoreTrigger;
  inputs: string[];    // declared input names, e.g. ['topic']
  binding: 'plan-time';
  approval: ChoreApproval;
  minConfidence: number;
  steps: ChoreStep[];
  hash: string;        // sha256 of the raw file (per-chore version)
  raw: string;
}

/** The cheap surface triage reads — description only, like a skill index. */
export interface ChoreIndexEntry { id: string; description: string }

/** Stored payload of a parked cast — everything needed to build the DAG on approval
 * without re-resolving (the chore itself is reloaded from disk by id). */
export interface ChoreCastPayload {
  choreId: string;
  inputs: Record<string, string>;
  cast: ResolvedCastStep[];
}

/** Result of casting one step against the agent roster (plan-time binding). */
export interface ResolvedCastStep {
  stepIndex: number;            // 0-based step index
  number: number;               // 1-based step number (display)
  capability: string;           // the step's `needs`
  agentName: string | null;     // chosen agent, or null when unresolved
  orgDbPageId: string | null;   // its Org DB page (the "Assigned To" target)
  confidence: number;
}

/** A task the compiler hands to proposeTasks. `dependsOn`/`assigneeIds` reuse the
 * existing createTaskPage contract; `dependsOn` are batch indices (0-based). */
export interface ChoreProposedTask {
  title: string;
  description?: string;
  dependsOn?: number[];
  assigneeIds?: string[];
}

/** Dependency-injected orchestrator primitives the compiler needs — passed in so
 * `chores/compile.ts` never statically imports `orchestrator.ts` (one-way edge:
 * orchestrator → chores). */
export interface CompileDeps {
  /** Cast one step: run the existing triage matcher for `needs` and resolve the agent. */
  resolveCast(needs: string, title: string): Promise<ResolvedCastStep>;
  /** Create the held, pre-assigned task DAG (= proposeTasks with assigneeIds). */
  createDag(tasks: ChoreProposedTask[]): Promise<{ created: { id: string; title: string }[] }>;
  /** Post a plain status note on the anchor page (e.g. "compiling…", "missing input"). */
  announce(text: string): Promise<void>;
  /** Post the cast for approval; returns the comment + thread to watch for the verdict. */
  postCast(text: string): Promise<{ commentId: string; discussionId: string | null }>;
}

export type CompileOutcome = 'compiled' | 'awaiting-cast' | 'blocked';
