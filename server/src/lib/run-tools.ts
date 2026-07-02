// Which NORC tools a run touched — a bitmask on task_runs.toolFlags, OR-ed in
// place at the call sites (no per-event table; a run row stays one row). The
// flags drive the per-tool feedback questions and per-tool happiness stats.

export const RunTool = {
  /** Slack was involved: slack-origin run, or the agent posted via the Slack Agent API. */
  SLACK: 1,
  /** The agent dispatched work to other agents (propose-tasks). */
  PROPOSE_TASKS: 2,
  /** Executed by a remote worker (OpenClaw adapter / remote Claude Code). */
  REMOTE_WORKER: 4,
  /** The run was auto-routed by the triage agent (no explicit @mention). */
  TRIAGE: 8,
} as const;

export type RunToolKey = 'slack' | 'propose_tasks' | 'remote_worker' | 'triage';

/** Feedback question per tool, in priority order (max 3 are asked). */
export const RUN_TOOL_QUESTIONS: { bit: number; key: RunToolKey; label: string }[] = [
  { bit: RunTool.TRIAGE, key: 'triage', label: 'How well did NORC pick the right agent for this task?' },
  { bit: RunTool.REMOTE_WORKER, key: 'remote_worker', label: 'How well did the remote coding agent perform?' },
  { bit: RunTool.PROPOSE_TASKS, key: 'propose_tasks', label: 'How useful were the follow-up tasks the agent created?' },
  { bit: RunTool.SLACK, key: 'slack', label: 'How was the Slack experience (replies, notifications)?' },
];

export const RUN_TOOL_LABELS: Record<RunToolKey, string> = {
  triage: 'Auto-triage',
  remote_worker: 'Remote worker',
  propose_tasks: 'Agent dispatch',
  slack: 'Slack',
};

/** The up-to-3 feedback questions for a run, from its toolFlags bitmask. */
export function questionsForFlags(toolFlags: number): { key: RunToolKey; label: string }[] {
  return RUN_TOOL_QUESTIONS
    .filter(q => (toolFlags & q.bit) !== 0)
    .slice(0, 3)
    .map(({ key, label }) => ({ key, label }));
}
