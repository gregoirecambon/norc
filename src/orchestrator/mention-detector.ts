import { isAgentPageId, findAgentByPageId } from '../notion/org-cache.js';
import { getTask } from '../notion/client.js';
import { classifyEvent } from './orchestrator-agent.js';
import { enqueueDispatch } from '../queue/dispatcher.js';

// Extract all Notion page ID references from a rich-text block array
function extractPageIds(richText: any[]): string[] {
  const ids: string[] = [];
  for (const block of richText ?? []) {
    // @mention of a page produces a mention object
    if (block.type === 'mention' && block.mention?.type === 'page') {
      ids.push(block.mention.page.id);
    }
  }
  return ids;
}

// Walk the event payload and find any page IDs referenced in content
function extractPageIdsFromEvent(event: any): string[] {
  const ids = new Set<string>();

  // Task status-change path: check if Status=Ready and Assigned Agent is set
  const props = event.updated_block?.properties ?? event.properties ?? {};
  const assignedAgentName = props['Assigned Agent']?.select?.name;
  const status = props.Status?.select?.name;

  if (status === 'Ready' && assignedAgentName) {
    // Not a page ID mention — signal via a synthetic agent name token
    ids.add('__assigned_agent__:' + assignedAgentName);
  }

  // Comment path: scan rich text for @mentions
  const commentBody = event.comment?.rich_text ?? [];
  for (const id of extractPageIds(commentBody)) ids.add(id);

  return Array.from(ids);
}

export async function extractAgentMentions(event: any, taskPageId: string): Promise<void> {
  const refs = extractPageIdsFromEvent(event);
  if (refs.length === 0) return;

  for (const ref of refs) {
    let agentName: string | null = null;

    if (ref.startsWith('__assigned_agent__:')) {
      agentName = ref.slice('__assigned_agent__:'.length);
    } else {
      // Cross-reference against Org DB cache
      if (!await isAgentPageId(ref)) continue;
      const agent = await findAgentByPageId(ref);
      agentName = agent?.name ?? null;
    }

    if (!agentName) continue;

    // Fetch authoritative task data from Notion API
    const task = await getTask(taskPageId).catch(() => null);
    if (!task) continue;

    // Haiku orchestrator: classify intent and detect anomalies
    const decision = await classifyEvent({
      taskId: taskPageId,
      taskName: task.name,
      taskStatus: task.status,
      assignedAgent: agentName,
      mentionContext: event.comment?.rich_text?.[0]?.plain_text ?? 'task assigned',
    });

    if (decision.action === 'execute') {
      await enqueueDispatch(decision);
    } else if (decision.action === 'notify_human') {
      console.warn(`[orchestrator] hold/notify for task ${taskPageId}: ${decision.anomalyReason}`);
    }
  }
}
