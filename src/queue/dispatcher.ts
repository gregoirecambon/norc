import { Queue, Worker, Job } from 'bullmq';
import { randomBytes } from 'crypto';
import type { OrchestratorDecision } from '../types/index.js';
import { assembleContext, buildPrompt } from '../notion/context-assembler.js';
import { findAgentByName } from '../notion/org-cache.js';
import { updateTaskStatus, appendComment, writeCheckpoint, incrementRetryCount } from '../notion/client.js';
import { executeClaudeCode } from '../adapters/claude-code.js';
import type { ExecutionContract } from '../types/index.js';

const connection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const dispatchQueue = new Queue('norc-dispatch', { connection });

export async function enqueueDispatch(decision: OrchestratorDecision): Promise<void> {
  const jobId = `${decision.taskId}:step-1`;

  // BullMQ deduplication: same job ID → second enqueue is rejected
  await dispatchQueue.add(
    'dispatch',
    { decision },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    }
  );
}

const callbackTokens = new Map<string, { taskId: string; resolve: (output: any) => void }>();

export function registerCallbackToken(token: string, taskId: string, resolve: (output: any) => void): void {
  callbackTokens.set(token, { taskId, resolve });
  // Auto-expire token after 2× max timeout (60 min default)
  setTimeout(() => callbackTokens.delete(token), 2 * 60 * 60 * 1000);
}

export function resolveCallback(token: string, output: any): boolean {
  const entry = callbackTokens.get(token);
  if (!entry) return false;
  callbackTokens.delete(token);
  entry.resolve(output);
  return true;
}

const worker = new Worker(
  'norc-dispatch',
  async (job: Job) => {
    const { decision } = job.data as { decision: OrchestratorDecision };
    const { taskId, assignedAgent } = decision;

    const agentRecord = await findAgentByName(assignedAgent);
    if (!agentRecord) throw new Error(`Agent not found: ${assignedAgent}`);

    // Write Status → Running FIRST (dedup: second webhook sees Running and is filtered)
    await updateTaskStatus(taskId, 'In Progress');
    await appendComment(
      taskId,
      `**@${assignedAgent}** started at ${new Date().toLocaleTimeString()} — estimated ${process.env.NORC_AGENT_TIMEOUT_MIN ?? 30} min`
    );

    const callbackToken = randomBytes(32).toString('hex');
    const callbackUrl = `${process.env.NORC_PUBLIC_URL}/api/callback/${callbackToken}`;
    const checkpointUrl = `${process.env.NORC_PUBLIC_URL}/api/checkpoint/${callbackToken}`;

    const contract: ExecutionContract = {
      norcVersion: '1.0',
      runId: job.id ?? randomBytes(8).toString('hex'),
      step: 1,
      callbackUrl,
      callbackToken,
      checkpointUrl,
      availableAgents: [],
      contextRef: `notion://tasks/${taskId}`,
    };

    const ctx = await assembleContext(taskId, assignedAgent, agentRecord.contextLevel as any);
    contract.availableAgents = ctx.availableAgents.map(a => a.name);

    const prompt = buildPrompt(ctx, contract);

    // Wait for agent callback with lock renewal
    const output = await new Promise<any>((resolve, reject) => {
      registerCallbackToken(callbackToken, taskId, resolve);

      const timeoutMs = Number(process.env.NORC_AGENT_TIMEOUT_MIN ?? 30) * 60 * 1000;
      const timeoutHandle = setTimeout(() => {
        callbackTokens.delete(callbackToken);
        reject(new Error(`Agent timeout after ${timeoutMs / 60000} min`));
      }, timeoutMs);

      // keepAlive: renew BullMQ lock every 30s during long-running agent work
      const keepAliveInterval = setInterval(() => {
        job.updateProgress(Date.now()).catch(() => {});
      }, 30_000);

      // Dispatch to adapter
      executeClaudeCode({ systemPrompt: prompt, task: ctx.taskName, timeoutMs, env: {}, contract })
        .then(result => {
          clearTimeout(timeoutHandle);
          clearInterval(keepAliveInterval);
          if (!result.success) {
            reject(new Error(`Adapter failed: ${result.stderr}`));
          }
          // For local Claude Code, adapter result IS the output (no callback needed)
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timeoutHandle);
          clearInterval(keepAliveInterval);
          reject(err);
        });
    });

    // Write checkpoint
    await writeCheckpoint(taskId, {
      pipelineRunId: contract.runId,
      completedSteps: [1],
      timestamp: new Date().toISOString(),
    });

    // Write output back to Notion
    const summary = output.summary ?? output.stdout?.slice(0, 500) ?? 'Completed';
    await appendComment(
      taskId,
      `**@${assignedAgent}** completed ✓\n\n${summary}`
    );
    await updateTaskStatus(taskId, 'Done');

    // Handle next_agent delegation
    if (output.nextAgent) {
      await appendComment(taskId, `Delegating to @${output.nextAgent}...`);
    }
  },
  {
    connection,
    lockDuration: 60_000,
    lockRenewTime: 30_000,
  }
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  const { decision } = job.data as { decision: OrchestratorDecision };
  const attempts = job.attemptsMade;
  const maxAttempts = 3;

  if (attempts >= maxAttempts) {
    await updateTaskStatus(decision.taskId, 'Failed');
    await appendComment(
      decision.taskId,
      `**@${decision.assignedAgent}** failed after ${maxAttempts} retries: ${err.message}`
    );
  } else {
    await incrementRetryCount(decision.taskId, attempts);
  }
});

worker.on('error', err => console.error('[queue] worker error:', err));
