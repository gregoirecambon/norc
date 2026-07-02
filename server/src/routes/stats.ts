// Historical statistics (behind apiAuthGuard): SQL aggregates over task_runs —
// no telemetry pipeline, no per-event tables. Cheap by construction: task_runs
// is capped at 90 days by pruneOldRuns(), so every query here scans a small
// table. Token numbers are agent-self-reported (best-effort) — the payload
// carries runsWithTokens so the UI can label the coverage honestly.

import { Router, type Router as ExpressRouter } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration } from '../db/schema.js';
import { userDisplayName } from '../lib/notion-anchor.js';
import { slackUserName } from '../lib/slack-client.js';
import { getSlack, isSlackActive } from '../lib/slack-integration.js';

const router: ExpressRouter = Router();

const WINDOWS = [7, 30, 90];

// GET /api/stats?days=7|30|90 — one payload, ~6 aggregate queries.
router.get('/', async (req, res) => {
  const days = WINDOWS.includes(Number(req.query['days'])) ? Number(req.query['days']) : 30;
  const cutoff = Date.now() - days * 24 * 3600_000;

  // Work-lane runs only (chat turns aren't tasks); finalized only for
  // rates/durations, so an in-flight run never skews the numbers.
  const scope = sql`lane = 'work' AND created_at >= ${cutoff}`;
  const finalized = sql`${scope} AND status != 'in_flight'`;

  const statusRows = db.all<{ status: string; count: number }>(
    sql`SELECT status, count(*) AS count FROM task_runs WHERE ${finalized} GROUP BY status`);
  const totalRuns = statusRows.reduce((a, r) => a + r.count, 0);
  const failedRuns = statusRows.filter(r => r.status !== 'done').reduce((a, r) => a + r.count, 0);

  const durationRow = db.all<{ avgMs: number | null }>(
    sql`SELECT avg(completed_at - created_at) AS avgMs FROM task_runs WHERE ${finalized} AND completed_at IS NOT NULL`)[0];

  const perDay = db.all<{ day: string; done: number; failed: number }>(
    sql`SELECT date(created_at / 1000, 'unixepoch') AS day,
               sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
               sum(CASE WHEN status != 'done' THEN 1 ELSE 0 END) AS failed
        FROM task_runs WHERE ${finalized} GROUP BY day ORDER BY day`);

  const topAgents = db.all<{ agentId: string; name: string | null; runs: number; avgMs: number | null; tokens: number | null }>(
    sql`SELECT r.agent_id AS agentId, a.name AS name, count(*) AS runs,
               avg(CASE WHEN r.completed_at IS NOT NULL THEN r.completed_at - r.created_at END) AS avgMs,
               sum(r.tokens_used) AS tokens
        FROM task_runs r LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.lane = 'work' AND r.created_at >= ${cutoff}
        GROUP BY r.agent_id ORDER BY runs DESC LIMIT 10`);

  // Humans: a slack-origin run knows a Slack id, a Notion run a Notion id —
  // group on whichever is set, tagged so names resolve through the right API.
  const topHumans = db.all<{ userId: string; kind: string; runs: number }>(
    sql`SELECT coalesce(triggering_slack_user_id, triggering_user_id) AS userId,
               CASE WHEN triggering_slack_user_id IS NOT NULL THEN 'slack' ELSE 'notion' END AS kind,
               count(*) AS runs
        FROM task_runs
        WHERE lane = 'work' AND created_at >= ${cutoff}
          AND coalesce(triggering_slack_user_id, triggering_user_id) IS NOT NULL
        GROUP BY userId, kind ORDER BY runs DESC LIMIT 10`);

  const tokenRow = db.all<{ total: number | null; reported: number }>(
    sql`SELECT sum(tokens_used) AS total, count(tokens_used) AS reported
        FROM task_runs WHERE ${scope}`)[0];

  // Resolve display names through the existing per-process caches.
  const integration = db.select().from(notionIntegration).all()[0];
  const apiKey = integration?.status === 'active' ? integration.apiKey : null;
  const botToken = isSlackActive() ? getSlack().botToken : null;
  const humans = await Promise.all(topHumans.map(async h => ({
    userId: h.userId,
    runs: h.runs,
    source: h.kind,
    name: h.kind === 'slack'
      ? (botToken ? await slackUserName(botToken, h.userId) : null)
      : (apiKey ? (await userDisplayName(apiKey, h.userId)) || null : null),
  })));

  res.json({
    days,
    totalRuns,
    errorRate: totalRuns === 0 ? null : failedRuns / totalRuns,
    avgDurationMs: durationRow?.avgMs ?? null,
    statuses: Object.fromEntries(statusRows.map(r => [r.status, r.count])),
    perDay,
    topAgents: topAgents.map(a => ({
      agentId: a.agentId, name: a.name ?? 'deleted agent',
      runs: a.runs, avgDurationMs: a.avgMs, tokens: a.tokens,
    })),
    topHumans: humans,
    tokens: { total: tokenRow?.total ?? null, runsWithTokens: tokenRow?.reported ?? 0 },
  });
});

export { router as statsRouter };
