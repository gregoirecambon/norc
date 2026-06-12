// Dashboard-facing Slack connection management (/api/slack) — the Slack
// analogue of routes/notion.ts. Secrets are write-only: GET returns
// botTokenSet/signingSecretSet booleans, never the values.

import { Router, type Router as ExpressRouter } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { slackIntegration } from '../db/schema.js';
import { emitLog } from '../lib/logger.js';
import { emitEvent } from '../lib/events.js';
import { zodMiddleware } from '../lib/validate.js';
import { norcBaseUrl } from '../lib/base-url.js';
import { notionIntegration, notionDatabases } from '../db/schema.js';
import { getSlack, getSlackRow, type SlackIntegrationRow } from '../lib/slack-integration.js';
import { slackAuthTest } from '../lib/slack-client.js';
import { provisionSlackChannelField } from '../lib/notion-provision.js';

const router: ExpressRouter = Router();

// When Slack connects and a Notion workspace is already provisioned, add the
// 'Slack Channel ID' field to the Projects DB so project↔channel binding
// works without a manual provisioning step. Best-effort: a failure logs and
// the field can still be added via POST /api/notion/provision/slack-channel.
async function ensureSlackChannelField(): Promise<void> {
  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration || integration.status !== 'active' || integration.workspaceStatus !== 'provisioned') return;
  const projects = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'projects')).all()[0];
  if (!projects) return;
  try {
    await provisionSlackChannelField(integration.apiKey, projects.notionDatabaseId);
    emitLog('Projects DB Slack Channel ID field provisioned', 'Slack');
  } catch (err) {
    emitLog(`could not add Slack Channel ID to Projects DB: ${err instanceof Error ? err.message : 'unknown'}`, 'Slack');
  }
}

function getWebhookUrl(): string {
  return `${norcBaseUrl()}/webhooks/slack`;
}

// The exact app manifest a user pastes into api.slack.com/apps → "From a
// manifest". Scopes/events are the full set the integration uses across all
// phases (mention parsing, per-agent personas, user-group handles).
function appManifest(): Record<string, unknown> {
  return {
    display_information: {
      name: 'Norc',
      description: 'Talk to your NORC agents from Slack',
      background_color: '#1a1d21',
    },
    features: {
      bot_user: { display_name: 'Norc', always_online: true },
      // The Messages tab is what makes DMs with the app possible — without
      // this, Slack greys out the message box on the app's profile.
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'chat:write',
          'chat:write.customize',
          'files:write',
          'channels:history', 'groups:history', 'im:history', 'mpim:history',
          'channels:read', 'groups:read',
          'channels:join',
          'im:write',
          'users:read',
          'usergroups:read', 'usergroups:write',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: getWebhookUrl(),
        bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

function safeRow(row: SlackIntegrationRow | null) {
  const resolved = getSlack();
  return {
    id: row?.id ?? null,
    status: row?.status ?? (resolved.source === 'env' ? 'active' : 'pending'),
    teamName: row?.teamName ?? null,
    botName: row?.botName ?? null,
    botUserId: row?.botUserId ?? null,
    appId: row?.appId ?? null,
    botTokenSet: !!(row?.botToken || resolved.source === 'env'),
    signingSecretSet: !!(row?.signingSecret || process.env['SLACK_SIGNING_SECRET']),
    source: resolved.source,
    webhookUrl: getWebhookUrl(),
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

// GET /api/slack
router.get('/', (_req, res) => {
  res.json({
    integration: safeRow(getSlackRow()),
    webhookUrl: getWebhookUrl(),
    manifest: appManifest(),
  });
});

// PUT /api/slack/config — save bot token and/or signing secret. Blank/absent
// fields keep stored values (the norcSettings secret-patch convention). Saving
// a token validates it via auth.test and captures the workspace identity.
const ConfigSchema = z.object({
  botToken: z.string().optional(),
  signingSecret: z.string().optional(),
});

router.put('/config', zodMiddleware(ConfigSchema), async (req, res) => {
  const { botToken, signingSecret } = req.body as z.infer<typeof ConfigSchema>;
  const now = Date.now();
  let row = getSlackRow();

  if (!row) {
    const id = randomUUID();
    db.insert(slackIntegration).values({ id, status: 'pending', createdAt: now, updatedAt: now }).run();
    row = getSlackRow()!;
  }

  const patch: Partial<typeof slackIntegration.$inferInsert> = { updatedAt: now };
  if (signingSecret?.trim()) patch.signingSecret = signingSecret.trim();

  if (botToken?.trim()) {
    try {
      const info = await slackAuthTest(botToken.trim());
      patch.botToken = botToken.trim();
      patch.botUserId = info.botUserId;
      patch.teamId = info.teamId;
      patch.teamName = info.teamName;
      patch.botName = info.botName;
      patch.appId = info.appId;
      patch.status = 'active';
      emitLog(`Slack bot token validated — workspace: ${info.teamName}`, 'Slack');
      void ensureSlackChannelField();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid bot token';
      res.status(400).json({ error: 'invalid_token', message: msg });
      return;
    }
  }

  db.update(slackIntegration).set(patch).where(eq(slackIntegration.id, row.id)).run();
  const updated = getSlackRow();
  emitEvent({
    type: 'slack.integration.updated',
    data: {
      status: updated?.status ?? 'pending',
      teamName: updated?.teamName ?? null,
      botName: updated?.botName ?? null,
      source: getSlack().source,
    },
  });
  res.json(safeRow(updated));
});

// POST /api/slack/test — re-run auth.test with the stored/env token.
router.post('/test', async (_req, res) => {
  const { botToken } = getSlack();
  if (!botToken) {
    res.status(400).json({ ok: false, error: 'No bot token configured.' });
    return;
  }
  const started = Date.now();
  try {
    const info = await slackAuthTest(botToken);
    const row = getSlackRow();
    if (row) {
      db.update(slackIntegration).set({
        botUserId: info.botUserId, teamId: info.teamId, teamName: info.teamName,
        botName: info.botName, appId: info.appId, status: 'active', updatedAt: Date.now(),
      }).where(eq(slackIntegration.id, row.id)).run();
    }
    res.json({ ok: true, teamName: info.teamName, botName: info.botName, latencyMs: Date.now() - started });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'auth.test failed';
    const row = getSlackRow();
    if (row?.botToken) {
      db.update(slackIntegration).set({ status: 'error', updatedAt: Date.now() })
        .where(eq(slackIntegration.id, row.id)).run();
    }
    res.json({ ok: false, error: msg, latencyMs: Date.now() - started });
  }
});

// DELETE /api/slack — disconnect (drop the stored credentials).
router.delete('/', (_req, res) => {
  const row = getSlackRow();
  if (row) {
    db.delete(slackIntegration).where(eq(slackIntegration.id, row.id)).run();
    emitLog('Slack integration disconnected', 'Slack');
    emitEvent({ type: 'slack.integration.updated', data: { status: 'pending', teamName: null, botName: null, source: getSlack().source } });
  }
  res.json({ ok: true });
});

export { router as slackRouter };
