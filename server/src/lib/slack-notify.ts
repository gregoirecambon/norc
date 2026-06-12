// Slack write-back for run completions. Separate from slack-orchestrator.ts
// (inbound) so orchestrator.ts can import it without a cycle.
//
// Two destinations, deduped:
//   1. The project's bound channel ('Slack Channel ID' on the Projects DB) —
//      every completed task whose project is bound gets a summary there.
//   2. The originating Slack thread (run.slackChannel/slackThreadTs) — when
//      the work was requested from Slack, the asker gets the result in-thread.
// When both point at the same channel, one threaded post serves both.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration, notionDatabases } from '../db/schema.js';
import { emitLog } from './logger.js';
import { getSlack, isSlackActive } from './slack-integration.js';
import { postAsAgent, ensureChannelMembership } from './slack-client.js';
import { agentSlackIcon } from './slack-agents.js';
import { notionGet, notionQuery } from './notion-client.js';
import { getRichText, getTitle } from './notion-props.js';
import { alreadyProcessed, markProcessed } from './processed-triggers.js';
import { titleSimilarity } from './task-similarity.js';
import type { TaskRun } from './runs.js';
import type { ProjectBlock } from './context-assembler.js';

const MAX_SUMMARY_CHARS = 1500;

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

/** The Slack channel bound to a project, or null. */
export async function projectSlackChannel(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active') return null;
  try {
    const page = await notionGet<Record<string, unknown>>(integration.apiKey, `/pages/${projectId}`);
    const channel = getRichText(page['properties'], 'Slack Channel ID').trim();
    return channel || null;
  } catch {
    return null;
  }
}

export interface ChannelProject {
  projectId: string;
  block: ProjectBlock;
}

function rowToProject(row: Record<string, unknown>): ChannelProject {
  const pp = row['properties'];
  return {
    projectId: String(row['id'] ?? ''),
    block: {
      name: getTitle(pp, 'Name'),
      objective: getRichText(pp, 'Objective'),
      kpis: getRichText(pp, 'KPIs'),
      docs: getRichText(pp, 'Docs'),
      slackChannelId: getRichText(pp, 'Slack Channel ID').trim(),
    },
  };
}

async function listProjects(): Promise<ChannelProject[]> {
  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active') return [];
  const projectsDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'projects')).all()[0];
  if (!projectsDb) return [];
  try {
    const res = await notionQuery<Record<string, unknown>>(integration.apiKey, projectsDb.notionDatabaseId, { page_size: 100 });
    const rows = (Array.isArray(res['results']) ? res['results'] : []) as Record<string, unknown>[];
    return rows.map(rowToProject).filter(p => p.block.name);
  } catch {
    return [];
  }
}

// Project names change rarely; the cache keeps Slack-message classification
// from querying Notion on every single mention.
let projectCache: { at: number; projects: ChannelProject[] } | null = null;
const PROJECT_CACHE_TTL_MS = 5 * 60_000;

async function cachedProjects(): Promise<ChannelProject[]> {
  if (projectCache && Date.now() - projectCache.at < PROJECT_CACHE_TTL_MS) return projectCache.projects;
  const projects = await listProjects();
  projectCache = { at: Date.now(), projects };
  return projects;
}

/** Project names for prompt context (e.g. the Slack task classifier). */
export async function listProjectNames(): Promise<string[]> {
  return (await cachedProjects()).map(p => p.block.name);
}

/**
 * Resolve a project the human NAMED in a message ("…for project lutai").
 * Exact title match first, then containment, then token similarity — null
 * when nothing is confidently close (callers fall back to channel binding).
 */
export async function findProjectByName(name: string): Promise<ChannelProject | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const projects = await cachedProjects();
  let best: ChannelProject | null = null;
  let bestScore = 0;
  for (const p of projects) {
    const title = p.block.name.trim().toLowerCase();
    const score = title === wanted ? 1
      : title.includes(wanted) || wanted.includes(title) ? 0.85
      : titleSimilarity(p.block.name, name);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 0.55 ? best : null;
}

/** Reverse lookup: the Notion project whose 'Slack Channel ID' is this channel. */
export async function projectForChannel(channel: string): Promise<ChannelProject | null> {
  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active') return null;
  const projectsDb = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'projects')).all()[0];
  if (!projectsDb) return null;
  try {
    const res = await notionQuery<Record<string, unknown>>(integration.apiKey, projectsDb.notionDatabaseId, {
      filter: { property: 'Slack Channel ID', rich_text: { equals: channel } },
      page_size: 1,
    });
    const row = (Array.isArray(res['results']) ? res['results'] : [])[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToProject(row);
  } catch {
    return null;
  }
}

function formatCompletion(run: TaskRun, outcome: 'done' | 'failed' | 'blocked', summary: string): string {
  const icon = outcome === 'done' ? '✅' : outcome === 'failed' ? '⚠️' : '🚧';
  const verb = outcome === 'done' ? 'done' : outcome === 'failed' ? 'failed' : 'blocked — needs human input';
  const title = run.title?.trim() || 'task';
  const body = summary.trim().slice(0, MAX_SUMMARY_CHARS);
  const link = run.taskPageId ? `\n<${notionUrl(run.taskPageId)}|Open in Notion>` : '';
  return `${icon} *${title}* — ${verb}.${body ? `\n${body}` : ''}${link}`;
}

/**
 * Post a run's completion summary to Slack (project channel and/or originating
 * thread). Best-effort and idempotent per run — several completion hooks can
 * fire for one run (/status Done, then /complete), only the first posts.
 * Notion-originated runs participate too: only projectId matters for the
 * channel leg.
 */
export async function notifySlackOnCompletion(
  run: TaskRun,
  outcome: 'done' | 'failed' | 'blocked',
  summary: string,
): Promise<void> {
  if (!isSlackActive()) return;
  // Chat-lane Slack conversations get their reply through the normal reply
  // path, not a completion broadcast.
  if (run.lane !== 'work') return;

  const projectChannel = await projectSlackChannel(run.projectId);
  const originChannel = run.slackChannel;
  if (!projectChannel && !originChannel) return;

  const dedupKey = `slack-complete:${run.id}`;
  if (alreadyProcessed(dedupKey)) return;
  markProcessed(dedupKey);

  const { botToken } = getSlack();
  if (!botToken) return;
  const agentName = db.select().from(agents).where(eq(agents.id, run.agentId)).all()[0]?.name ?? 'NORC';
  const iconUrl = await agentSlackIcon(run.agentId);
  const text = formatCompletion(run, outcome, summary);

  const posts: { channel: string; threadTs: string | null }[] = [];
  if (originChannel) posts.push({ channel: originChannel, threadTs: run.slackThreadTs ?? null });
  if (projectChannel && projectChannel !== originChannel) posts.push({ channel: projectChannel, threadTs: null });

  for (const p of posts) {
    try {
      // The project channel may be one we've never posted in — self-join
      // public channels; a private channel logs the /invite remedy instead.
      const membership = await ensureChannelMembership(botToken, p.channel);
      if (!membership.ok) {
        emitLog(`slack completion post skipped for ${p.channel}: ${membership.message}`, agentName, run.taskPageId ?? undefined);
        continue;
      }
      if (membership.joined) emitLog(`Norc auto-joined ${membership.name ? '#' + membership.name : p.channel} for completion summaries`, 'Slack');
      await postAsAgent(botToken, { channel: p.channel, text, threadTs: p.threadTs, agentName, iconUrl });
      emitLog(`completion summary posted to Slack ${p.channel}${p.threadTs ? ' (thread)' : ''} (run ${run.id})`, agentName, run.taskPageId ?? undefined);
    } catch (err) {
      emitLog(`slack completion post failed for ${p.channel}: ${err instanceof Error ? err.message : 'unknown'}`, agentName);
    }
  }
}
