// Notion write-back — how NORC speaks and updates state in a conversation.
//   - postComment: reply into the thread
//   - setTaskStatus / setTaskFields: task lifecycle (status, Agent Output, …)
//   - setAgentStatus / touchLastActive: reflect agent state on its Org DB page

import { notionPost, notionPatch } from './notion-client.js';

export interface NewTask {
  title: string;
  kpis?: string;
  projectId?: string | null;
  /** Task Status to create with (default 'Backlog'; 'Proposed' for co-CEO proposals). */
  status?: string;
  /** Org DB page ids to set as "Assigned To" (e.g. copied from a recurring template). */
  assigneeIds?: string[];
  /** Task page ids this task "Depends On" — held until they're all Done. */
  dependsOn?: string[];
  /** Recurrence preset for a proposed routine ('Daily'|'Weekdays'|'Weekly'|'Monthly'); omit/None for one-shots. */
  recurrence?: string;
  /** Custom cadence in days; wins over the preset (matches scheduler.nextOccurrence). */
  repeatEveryDays?: number;
  /** ISO date to first schedule the task/template (the scheduler fires it once Status is Backlog). */
  scheduledFor?: string | null;
}

/**
 * Create a task row in the Tasks DB — used for agent-proposed work, co-CEO proposals,
 * and recurring-task instances. Defaults to Backlog; optionally links a Project and
 * sets assignees. Returns the new id.
 */
export async function createTaskPage(apiKey: string, tasksDbId: string, task: NewTask): Promise<{ pageId: string; url: string }> {
  const properties: Record<string, unknown> = {
    'Name': { title: toRichText(task.title) },
    'Status': { select: { name: task.status ?? 'Backlog' } },
  };
  if (task.kpis && task.kpis.trim()) {
    properties['KPIs'] = { rich_text: toRichText(task.kpis.slice(0, RICH_TEXT_LIMIT)) };
  }
  if (task.projectId) {
    properties['Project'] = { relation: [{ id: task.projectId }] };
  }
  if (task.assigneeIds && task.assigneeIds.length) {
    properties['Assigned To'] = { relation: task.assigneeIds.filter(Boolean).map(id => ({ id })) };
  }
  if (task.dependsOn && task.dependsOn.length) {
    properties['Depends On'] = { relation: task.dependsOn.filter(Boolean).map(id => ({ id })) };
  }
  // Recurrence — set only for a proposed routine. The scheduler treats a 'Proposed'
  // status as inert, so a proposed routine is HELD (won't fire) until a human moves
  // it to Backlog; the date is the first occurrence once approved.
  if (task.recurrence && task.recurrence !== 'None') {
    properties['Recurrence'] = { select: { name: task.recurrence } };
  }
  if (typeof task.repeatEveryDays === 'number' && task.repeatEveryDays > 0) {
    properties['Repeat Every (days)'] = { number: Math.floor(task.repeatEveryDays) };
  }
  if (task.scheduledFor) {
    properties['Scheduled For'] = { date: { start: task.scheduledFor } };
  }
  const res = await notionPost<Record<string, unknown>>(apiKey, '/pages', {
    parent: { database_id: tasksDbId },
    properties,
  });
  return { pageId: String(res['id'] ?? ''), url: String(res['url'] ?? '') };
}

/** Archive a page (move to Notion trash) — e.g. dismissing a proposed task. */
export async function archivePage(apiKey: string, pageId: string): Promise<void> {
  await notionPatch(apiKey, `/pages/${pageId}`, { archived: true });
}

/** Set (or clear, with null) a task's "Scheduled For" date. */
export async function setTaskScheduledFor(apiKey: string, taskPageId: string, iso: string | null): Promise<void> {
  await notionPatch(apiKey, `/pages/${taskPageId}`, {
    properties: { 'Scheduled For': { date: iso ? { start: iso } : null } },
  });
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

/** Rich text that opens with a real Notion @user mention (so they get notified). */
function toRichTextMentioning(userId: string, text: string): unknown[] {
  return [
    { type: 'mention', mention: { type: 'user', user: { id: userId } } },
    ...toRichText(` ${text}`),
  ];
}

// A rich-text segment: plain text, a page @mention (e.g. an agent's Org DB page or
// a task), or a user @mention. buildRichText interleaves them so NORC can write
// "Created <@task> — assigned <@agent>" with real, clickable mentions.
export type RichSeg = string | { pageId: string } | { userId: string };

export function buildRichText(segs: RichSeg[]): unknown[] {
  const out: unknown[] = [];
  for (const s of segs) {
    if (typeof s === 'string') { if (s) out.push(...toRichText(s)); }
    else if ('pageId' in s) out.push({ type: 'mention', mention: { type: 'page', page: { id: s.pageId } } });
    else out.push({ type: 'mention', mention: { type: 'user', user: { id: s.userId } } });
  }
  return out.length ? out : toRichText(' ');
}

/** Post a page comment built from rich segments (real @mentions). */
export async function postCommentRich(apiKey: string, pageId: string, segs: RichSeg[]): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    parent: { page_id: pageId },
    rich_text: buildRichText(segs),
  });
  return { commentId: String(res['id'] ?? '') };
}

/** Reply into a discussion built from rich segments (real @mentions). */
export async function postCommentReplyRich(apiKey: string, discussionId: string, segs: RichSeg[]): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    discussion_id: discussionId,
    rich_text: buildRichText(segs),
  });
  return { commentId: String(res['id'] ?? '') };
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

/** Post a page comment that @mentions a user (used to pull a human into the loop). */
export async function postCommentMentioning(
  apiKey: string,
  pageId: string,
  userId: string,
  text: string,
): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    parent: { page_id: pageId },
    rich_text: toRichTextMentioning(userId, text),
  });
  return { commentId: String(res['id'] ?? '') };
}

/** Reply into a discussion with a leading @user mention. */
export async function postCommentReplyMentioning(
  apiKey: string,
  discussionId: string,
  userId: string,
  text: string,
): Promise<{ commentId: string }> {
  const res = await notionPost<Record<string, unknown>>(apiKey, '/comments', {
    discussion_id: discussionId,
    rich_text: toRichTextMentioning(userId, text),
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

export type TaskStatus = 'Backlog' | 'Queued' | 'In Progress' | 'Done' | 'Failed' | 'Blocked';

/** Set a Task page's Status select. */
export async function setTaskStatus(apiKey: string, taskPageId: string, status: TaskStatus): Promise<void> {
  await notionPatch(apiKey, `/pages/${taskPageId}`, {
    properties: { 'Status': { select: { name: status } } },
  });
}

/** Set a Task page's "Assigned To" relation to one or more agent Org DB pages. */
export async function setTaskAssignee(apiKey: string, taskPageId: string, orgDbPageIds: string[]): Promise<void> {
  await notionPatch(apiKey, `/pages/${taskPageId}`, {
    properties: { 'Assigned To': { relation: orgDbPageIds.filter(Boolean).map(id => ({ id })) } },
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
