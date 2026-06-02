import { Client } from '@notionhq/client';
import { updateTaskStatus, appendComment, incrementRetryCount } from '../notion/client.js';

const MAX_RETRIES = 3;

export async function detectStaleRuns(): Promise<void> {
  const tasksDbId = process.env.NOTION_TASKS_DB_ID;
  if (!tasksDbId) return;

  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const timeoutMin = Number(process.env.NORC_AGENT_TIMEOUT_MIN ?? 30);
  const staleThresholdMs = timeoutMin * 2 * 60 * 1000;

  let response: any;
  try {
    // SDK v5 removed databases.query() — use raw request
    response = await (notion as any).request({
      path: `databases/${tasksDbId}/query`,
      method: 'POST',
      body: { filter: { property: 'Status', select: { equals: 'In Progress' } } },
    });
  } catch (err) {
    console.error('[startup] stale-run detection failed:', err);
    return;
  }

  for (const page of response.results ?? []) {
    const props = page.properties;
    const checkpoint = props['Last Checkpoint']?.rich_text?.[0]?.plain_text;
    const retryCount = props['Retry Count']?.number ?? 0;

    let isStale = false;
    if (checkpoint) {
      try {
        const parsed = JSON.parse(checkpoint);
        const age = Date.now() - new Date(parsed.timestamp).getTime();
        isStale = age > staleThresholdMs;
      } catch {
        isStale = true;
      }
    } else {
      // No checkpoint at all — likely stale
      isStale = true;
    }

    if (!isStale) continue;

    const taskId = page.id;

    if (retryCount >= MAX_RETRIES) {
      await updateTaskStatus(taskId, 'Failed');
      await appendComment(taskId, `**NORC** task marked as failed after ${MAX_RETRIES} retries — NORC was offline during the last run.`);
    } else {
      await incrementRetryCount(taskId, retryCount);
      await updateTaskStatus(taskId, 'Ready');
      await appendComment(
        taskId,
        `**NORC** is back online. This task appears stalled and will be retried (attempt ${retryCount + 1}/${MAX_RETRIES}).`
      );
    }
  }
}
