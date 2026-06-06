// Notion write-back — how NORC speaks and updates state in a conversation.
//   - postComment: reply into the thread
//   - setTaskStatus / setTaskFields: task lifecycle (status, Agent Output, …)
//   - setAgentStatus / touchLastActive: reflect agent state on its Org DB page

import { notionPost, notionPatch } from './notion-client.js';

export interface NewTask {
  title: string;
  kpis?: string;
  projectId?: string | null;
}

/**
 * Create a Backlog task row in the Tasks DB — used when an agent proposes follow-up
 * work that NORC then triages. Optionally links it to a Project. Returns the new id.
 */
export async function createTaskPage(apiKey: string, tasksDbId: string, task: NewTask): Promise<{ pageId: string }> {
  const properties: Record<string, unknown> = {
    'Name': { title: toRichText(task.title) },
    'Status': { select: { name: 'Backlog' } },
  };
  if (task.kpis && task.kpis.trim()) {
    properties['KPIs'] = { rich_text: toRichText(task.kpis.slice(0, RICH_TEXT_LIMIT)) };
  }
  if (task.projectId) {
    properties['Project'] = { relation: [{ id: task.projectId }] };
  }
  const res = await notionPost<Record<string, unknown>>(apiKey, '/pages', {
    parent: { database_id: tasksDbId },
    properties,
  });
  return { pageId: String(res['id'] ?? '') };
}

// Notion accepts at most 100 child blocks per append request.
const MAX_BLOCKS_PER_APPEND = 100;

// Notion caps a single rich_text text content at 2000 characters; longer
// values must be split across multiple rich_text segments.
const RICH_TEXT_LIMIT = 2000;

export function toRichText(text: string): { type: 'text'; text: { content: string } }[] {
  const segments: { type: 'text'; text: { content: string } }[] = [];
  let remaining = text.length > 0 ? text : ' ';
  while (remaining.length > 0) {
    segments.push({ type: 'text', text: { content: remaining.slice(0, RICH_TEXT_LIMIT) } });
    remaining = remaining.slice(RICH_TEXT_LIMIT);
  }
  return segments;
}

/** Post a comment on a page; returns the created comment id (for loop guard). */
export async function postComment(
  apiKey: string,
  pageId: string,
  text: string,
): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    parent: { page_id: pageId },
    rich_text: toRichText(text),
  });
  return { commentId: String(res['id'] ?? '') };
}

/**
 * Reply inside an existing discussion — the comment lands on the exact text the
 * discussion is anchored to (an inline comment on a block, or a page thread),
 * rather than as a fresh page-level comment. Returns the created comment id.
 */
export async function postCommentReply(
  apiKey: string,
  discussionId: string,
  text: string,
): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    discussion_id: discussionId,
    rich_text: toRichText(text),
  });
  return { commentId: String(res['id'] ?? '') };
}

/** Append child blocks to a page/block, chunked to Notion's 100-per-call limit. */
export async function appendBlocks(apiKey: string, pageId: string, blocks: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_APPEND) {
    const children = blocks.slice(i, i + MAX_BLOCKS_PER_APPEND);
    await notionPatch(apiKey, `/blocks/${pageId}/children`, { children });
  }
}

export type TaskStatus = 'Backlog' | 'In Progress' | 'Done' | 'Failed';

/** Set a Task page's Status select. */
export async function setTaskStatus(apiKey: string, taskPageId: string, status: TaskStatus): Promise<void> {
  await notionPatch(apiKey, `/pages/${taskPageId}`, {
    properties: { 'Status': { select: { name: status } } },
  });
}

export interface TaskFields {
  agentOutput?: string;
  lastCheckpoint?: string;
}

/** Write Task summary fields. Agent Output is the at-a-glance result (capped). */
export async function setTaskFields(apiKey: string, taskPageId: string, fields: TaskFields): Promise<void> {
  const properties: Record<string, unknown> = {};
  if (fields.agentOutput !== undefined) {
    properties['Agent Output'] = { rich_text: toRichText(fields.agentOutput.slice(0, RICH_TEXT_LIMIT)) };
  }
  if (fields.lastCheckpoint !== undefined) {
    properties['Last Checkpoint'] = { rich_text: toRichText(fields.lastCheckpoint.slice(0, RICH_TEXT_LIMIT)) };
  }
  if (Object.keys(properties).length === 0) return;
  await notionPatch(apiKey, `/pages/${taskPageId}`, { properties });
}

export type AgentStatus = 'Available' | 'Busy' | 'Offline';

/** Set an agent's Org DB page Status select. */
export async function setAgentStatus(apiKey: string, orgDbPageId: string, status: AgentStatus): Promise<void> {
  await notionPatch(apiKey, `/pages/${orgDbPageId}`, {
    properties: { 'Status': { select: { name: status } } },
  });
}

/** Stamp the agent's Org DB "Last Active" date to now. */
export async function touchLastActive(apiKey: string, orgDbPageId: string): Promise<void> {
  await notionPatch(apiKey, `/pages/${orgDbPageId}`, {
    properties: { 'Last Active': { date: { start: new Date().toISOString() } } },
  });
}
