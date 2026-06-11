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
import { notionGet, notionQuery } from './notion-client.js';
import { getRichText, getTitle } from './notion-props.js';
import { alreadyProcessed, markProcessed } from './processed-triggers.js';
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
    const pp = row['properties'];
    return {
      projectId: String(row['id'] ?? ''),
      block: {
        name: getTitle(pp, 'Name'),
        objective: getRichText(pp, 'Objective'),
        kpis: getRichText(pp, 'KPIs'),
        docs: getRichText(pp, 'Docs'),
        slackChannelId: channel,
      },
    };
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
      await postAsAgent(botToken, { channel: p.channel, text, threadTs: p.threadTs, agentName });
      emitLog(`completion summary posted to Slack ${p.channel}${p.threadTs ? ' (thread)' : ''} (run ${run.id})`, agentName, run.taskPageId ?? undefined);
    } catch (err) {
      emitLog(`slack completion post failed for ${p.channel}: ${err instanceof Error ? err.message : 'unknown'}`, agentName);
    }
  }
}
