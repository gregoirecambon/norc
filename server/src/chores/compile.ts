// The chore compiler. Given a selected chore + the triggering task's inputs, it:
//   1. checks every {placeholder} can be filled (else asks the human),
//   2. resolves the full cast up front (plan-time binding) via deps.resolveCast,
//   3. gates on approval — `approval: cast`, or any unconfident step even under
//      `approval: auto` (fail-safe), parks the cast for a human "approve",
//   4. otherwise builds the pre-assigned, held task DAG via deps.createDag.
//
// It imports NO orchestrator code — entangled primitives arrive via CompileDeps,
// so the dependency edge is one-way (orchestrator → chores).

import { substituteInputs } from './force.js';
import { attachCastComment, createPendingCast, renderCast } from './casts.js';
import type {
  ChoreDoc, ChoreProposedTask, CompileDeps, CompileOutcome, ResolvedCastStep,
} from './types.js';

const TITLE_MAX = 120;

function firstLine(s: string): string {
  const line = s.split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** A step is "resolved" when an agent was matched at/above the chore's confidence floor. */
function isResolved(c: ResolvedCastStep, minConfidence: number): boolean {
  return !!c.orgDbPageId && c.confidence >= minConfidence;
}

/** Collect input placeholders that no provided value covers, across all steps. */
function missingInputs(chore: ChoreDoc, inputs: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const step of chore.steps) {
    for (const text of [step.do, step.returns ?? '']) {
      for (const m of substituteInputs(text, inputs).missing) missing.add(m);
    }
  }
  return [...missing];
}

/** Build the proposeTasks payload from a (resolved) cast. Exported so the cast-approval
 * verdict handler can rebuild the DAG from a stored cast without re-resolving. */
export function buildTasksFromCast(
  chore: ChoreDoc,
  inputs: Record<string, string>,
  cast: ResolvedCastStep[],
): ChoreProposedTask[] {
  return chore.steps.map(step => {
    const doText = substituteInputs(step.do, inputs).text;
    const returns = step.returns ? substituteInputs(step.returns, inputs).text : '';
    const description = returns ? `${doText}\n\nExpected output:\n${returns}` : doText;
    const resolved = cast.find(c => c.stepIndex === step.index);
    const assigneeIds = resolved?.orgDbPageId ? [resolved.orgDbPageId] : undefined;
    return {
      title: step.title ? substituteInputs(step.title, inputs).text : firstLine(doText),
      description,
      dependsOn: step.after,
      assigneeIds,
    };
  });
}

export interface CompileArgs {
  chore: ChoreDoc;
  inputs: Record<string, string>;
  sourcePageId: string;
  pageId: string;
  via: 'forced' | 'triage';
  proposedByUserId?: string | null;
}

export async function compileChore(deps: CompileDeps, args: CompileArgs): Promise<CompileOutcome> {
  const { chore, inputs } = args;

  // 1. Inputs — never compile a half-templated DAG.
  const missing = missingInputs(chore, inputs);
  if (missing.length) {
    await deps.announce(
      `I can't start the “${chore.id}” process yet — it needs: ${missing.join(', ')}. ` +
      `Add ${missing.length === 1 ? 'it' : 'them'} to the task and try again.`,
    );
    return 'blocked';
  }

  // 2. Plan-time cast — resolve each step to an agent via the existing matcher.
  const cast: ResolvedCastStep[] = [];
  for (const step of chore.steps) {
    const title = step.title ? substituteInputs(step.title, inputs).text : firstLine(substituteInputs(step.do, inputs).text);
    const r = await deps.resolveCast(step.needs, title);
    cast.push({ ...r, stepIndex: step.index, number: step.number, capability: step.needs });
  }

  // 3. Approval gate — `cast` always asks; `auto` asks only if a step is unconfident.
  const allResolved = cast.every(c => isResolved(c, chore.minConfidence));
  const needsApproval = chore.approval === 'cast' || !allResolved;
  if (needsApproval) {
    const castText = renderCast(chore, cast);
    const posted = await deps.postCast(castText);
    const row = createPendingCast({
      choreId: chore.id,
      sourcePageId: args.sourcePageId,
      payload: { choreId: chore.id, inputs, cast },
      castText,
      pageId: args.pageId,
      proposedByUserId: args.proposedByUserId ?? null,
    });
    attachCastComment(row.id, posted.commentId, posted.discussionId);
    return 'awaiting-cast';
  }

  // 4. Build the held, pre-assigned DAG.
  await deps.createDag(buildTasksFromCast(chore, inputs, cast));
  return 'compiled';
}
