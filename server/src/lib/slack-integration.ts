// Singleton accessor for the Slack workspace connection — the Slack analogue
// of reading notionIntegration. DB values win; SLACK_BOT_TOKEN /
// SLACK_SIGNING_SECRET env vars are the fallback (same posture as SMTP in
// norc-settings.ts), so a docker-compose install can skip the dashboard step.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { slackIntegration } from '../db/schema.js';

export type SlackIntegrationRow = typeof slackIntegration.$inferSelect;

export interface ResolvedSlack {
  row: SlackIntegrationRow | null;
  botToken: string | null;
  signingSecret: string | null;
  botUserId: string | null;
  /** Where the credentials came from — drives the settings-page status pill. */
  source: 'settings' | 'env' | null;
}

export function getSlackRow(): SlackIntegrationRow | null {
  return db.select().from(slackIntegration).all()[0] ?? null;
}

export function getSlack(): ResolvedSlack {
  const row = getSlackRow();
  // DB values win field-by-field; SLACK_* env vars fill the gaps.
  const envSecret = process.env['SLACK_SIGNING_SECRET'] || null;
  if (row?.botToken) {
    return {
      row,
      botToken: row.botToken,
      signingSecret: row.signingSecret || envSecret,
      botUserId: row.botUserId,
      source: 'settings',
    };
  }
  const envToken = process.env['SLACK_BOT_TOKEN'] || null;
  if (envToken) {
    return {
      row,
      botToken: envToken,
      signingSecret: row?.signingSecret || envSecret,
      botUserId: row?.botUserId ?? null,
      source: 'env',
    };
  }
  return { row, botToken: null, signingSecret: row?.signingSecret || envSecret, botUserId: null, source: null };
}

/** Slack is usable for outbound posts: we have a token and the row isn't errored. */
export function isSlackActive(): boolean {
  const s = getSlack();
  if (!s.botToken) return false;
  return !s.row || s.row.status !== 'error' || s.source === 'env';
}

// ─── Synthetic run anchors ──────────────────────────────────────────────────
// Slack-chat conversations have no Notion page; their runs/sessions anchor on
// `slack:<channelId>:<threadRootTs>` instead. These live here (not in
// slack-orchestrator.ts) so orchestrator.ts can guard its Notion writes
// without an import cycle.

export function slackAnchorId(channel: string, threadTs: string): string {
  return `slack:${channel}:${threadTs}`;
}

export function isSlackAnchor(pageId: string): boolean {
  return pageId.startsWith('slack:');
}

export function parseSlackAnchor(pageId: string): { channel: string; threadTs: string } | null {
  if (!isSlackAnchor(pageId)) return null;
  const [, channel, threadTs] = pageId.split(':');
  if (!channel || !threadTs) return null;
  return { channel, threadTs };
}

export function updateSlackRow(patch: Partial<typeof slackIntegration.$inferInsert>): SlackIntegrationRow | null {
  const row = getSlackRow();
  if (!row) return null;
  db.update(slackIntegration).set({ ...patch, updatedAt: Date.now() }).where(eq(slackIntegration.id, row.id)).run();
  return getSlackRow();
}
