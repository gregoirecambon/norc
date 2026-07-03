// Post-run human feedback. When a work run finalizes, a sampled fraction of
// runs (norc_settings.feedbackSampleRate) mints a 7-day invite for the HUMAN
// who triggered the task and delivers a public form link over the configured
// channel (Slack DM or email). Unresolvable recipients still get an invite row
// — the dashboard's copy-link button is the universal fallback. Everything here
// is best-effort and must never disturb the run pipeline.

import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, feedbackInvites, notionIntegration } from '../db/schema.js';
import { getNorcSettingsOrDefault } from './norc-settings.js';
import { onEvent } from './events.js';
import { getRun, type TaskRun } from './runs.js';
import { questionsForFlags } from './run-tools.js';
import { emitLog } from './logger.js';
import { norcBaseUrl } from './base-url.js';
import { getSlack, isSlackActive } from './slack-integration.js';
import { postAsAgent, slackPost, slackUserName, type SlackOk } from './slack-client.js';
import { sendFeedbackEmail, isMailerConfigured } from './mailer.js';
import { userProfile } from './notion-anchor.js';

export type FeedbackInvite = typeof feedbackInvites.$inferSelect;

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
// Don't ask the same human twice within a day, however many runs they trigger.
const RECIPIENT_DEBOUNCE_MS = 24 * 3600_000;

export function feedbackFormUrl(token: string): string {
  // Under /api on purpose: every deployment already proxies /api to the server,
  // while a bare /feedback path needs an nginx location block that older
  // installs don't have (it would fall through to the SPA → dashboard).
  return `${norcBaseUrl()}/api/feedback/form/${token}`;
}

/** Wire the run.finished → maybe-invite listener. Called once at boot. */
export function initFeedback(): void {
  onEvent(event => {
    if (event.type !== 'run.finished') return;
    // Hop off the synchronous emitter stack (finalizeRun may fire mid-turn).
    setImmediate(() => {
      void maybeInviteForRun(event.data.id).catch(err =>
        emitLog(`feedback invite error for run ${event.data.id}: ${err instanceof Error ? err.message : 'unknown'}`));
    });
  });
}

/** Sample a finished run and, when it wins the draw, mint + send an invite.
 * Exported for tests and for a forced invite path. */
export async function maybeInviteForRun(runId: string, opts?: { force?: boolean }): Promise<FeedbackInvite | null> {
  const settings = getNorcSettingsOrDefault();
  if (!settings.feedbackEnabled) return null;
  const run = getRun(runId);
  if (!run) return null;
  // Only real tasks: chat-lane runs are ephemeral conversation turns (the
  // notifySlackOnCompletion precedent).
  if (run.lane !== 'work') return null;
  if (!opts?.force && Math.random() >= settings.feedbackSampleRate) return null;
  // One invite per run, ever.
  const existing = db.select().from(feedbackInvites).where(eq(feedbackInvites.runId, run.id)).all()[0];
  if (existing) return null;

  const recipient = await resolveRecipient(run, settings.feedbackChannel as 'slack' | 'email');
  // Debounce per human: skip when a pending invite for this recipient is <24h old.
  if (recipient.recipient) {
    const recent = db.select().from(feedbackInvites)
      .where(and(
        eq(feedbackInvites.recipient, recipient.recipient),
        gt(feedbackInvites.createdAt, Date.now() - RECIPIENT_DEBOUNCE_MS),
      )).all()[0];
    if (recent) return null;
  }

  const invite = mintInvite(run, recipient);
  await sendInvite(invite);
  return db.select().from(feedbackInvites).where(eq(feedbackInvites.id, invite.id)).all()[0] ?? null;
}

interface ResolvedRecipient {
  channel: 'slack' | 'email';
  recipient: string | null;   // slack user id or email address
  recipientName: string | null;
}

/**
 * Find the human behind the run on the preferred channel, falling back to the
 * other channel, then to an unaddressed invite (dashboard copy-link only).
 *   Slack-origin runs know the Slack user id directly; their email comes from
 *   users.info. Notion-origin runs know the Notion user id; their Slack id is
 *   bridged via person.email → users.lookupByEmail.
 */
async function resolveRecipient(run: TaskRun, preferred: 'slack' | 'email'): Promise<ResolvedRecipient> {
  const slack = isSlackActive() ? getSlack() : null;
  const botToken = slack?.botToken ?? null;
  const integration = db.select().from(notionIntegration).all()[0];
  const apiKey = integration?.status === 'active' ? integration.apiKey : null;

  const notionUser = run.triggeringUserId && apiKey ? await userProfile(apiKey, run.triggeringUserId) : null;
  const slackUserId = run.triggeringSlackUserId;
  const name = slackUserId && botToken
    ? await slackUserName(botToken, slackUserId)
    : notionUser?.name || null;

  const asSlack = async (): Promise<ResolvedRecipient | null> => {
    if (!botToken) return null;
    if (slackUserId) return { channel: 'slack', recipient: slackUserId, recipientName: name };
    // Notion-origin: bridge through the email — needs users:read.email scope.
    if (notionUser?.email) {
      const id = await slackIdByEmail(botToken, notionUser.email);
      if (id) return { channel: 'slack', recipient: id, recipientName: name };
    }
    return null;
  };
  const asEmail = async (): Promise<ResolvedRecipient | null> => {
    if (!isMailerConfigured()) return null;
    if (notionUser?.email) return { channel: 'email', recipient: notionUser.email, recipientName: name };
    if (slackUserId && botToken) {
      const email = await slackUserEmail(botToken, slackUserId);
      if (email) return { channel: 'email', recipient: email, recipientName: name };
    }
    return null;
  };

  const order = preferred === 'slack' ? [asSlack, asEmail] : [asEmail, asSlack];
  for (const resolve of order) {
    const r = await resolve().catch(() => null);
    if (r) return r;
  }
  return { channel: preferred, recipient: null, recipientName: name };
}

function mintInvite(run: TaskRun, recipient: ResolvedRecipient): FeedbackInvite {
  const now = Date.now();
  const invite: FeedbackInvite = {
    id: randomUUID(),
    runId: run.id,
    token: randomBytes(24).toString('hex'),
    channel: recipient.channel,
    recipient: recipient.recipient,
    recipientName: recipient.recipientName,
    runTitle: run.title,
    agentId: run.agentId,
    agentName: agentNameFor(run.agentId),
    runStatus: run.status,
    questionsJson: JSON.stringify(questionsForFlags(run.toolFlags)),
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    sentAt: null,
  };
  db.insert(feedbackInvites).values(invite).run();
  return invite;
}

/** Deliver (or re-deliver) an invite over its channel. Sets sentAt on success;
 * a copy-link-only invite (no recipient) is left unsent without complaint. */
export async function sendInvite(invite: FeedbackInvite): Promise<{ sent: boolean; error?: string }> {
  if (!invite.recipient) return { sent: false, error: 'no_recipient' };
  const url = feedbackFormUrl(invite.token);
  const title = invite.runTitle ?? 'your task';
  const agentName = invite.agentName ?? 'An agent';

  let result: { sent: boolean; error?: string };
  if (invite.channel === 'slack') {
    const slack = isSlackActive() ? getSlack() : null;
    if (!slack?.botToken) result = { sent: false, error: 'slack_not_active' };
    else {
      try {
        // Posting to a user id opens the DM. DMs always render as the app.
        await postAsAgent(slack.botToken, {
          channel: invite.recipient,
          text: `*${agentName}* just finished “${title}”. How was it?\n\nHelp us improve NORC — rate this run (takes ~20s): ${url}\n_The link expires in 7 days._`,
        });
        result = { sent: true };
      } catch (err) {
        result = { sent: false, error: err instanceof Error ? err.message : 'slack_error' };
      }
    }
  } else {
    result = await sendFeedbackEmail(invite.recipient, { formUrl: url, runTitle: title, agentName });
  }

  if (result.sent) {
    db.update(feedbackInvites).set({ sentAt: Date.now() }).where(eq(feedbackInvites.id, invite.id)).run();
    emitLog(`feedback invite sent via ${invite.channel} to ${invite.recipientName ?? invite.recipient} for run ${invite.runId}`);
  } else {
    emitLog(`feedback invite for run ${invite.runId} not sent (${result.error}) — copy the link from the dashboard`);
  }
  return result;
}

/** Expired links self-destruct: hourly sweep companion to the lazy check on
 * form access. Returns the number of pruned invites. */
export function pruneExpiredFeedbackInvites(): number {
  return db.delete(feedbackInvites).where(lt(feedbackInvites.expiresAt, Date.now())).run().changes;
}

function agentNameFor(agentId: string): string | null {
  return db.select().from(agents).where(eq(agents.id, agentId)).all()[0]?.name ?? null;
}

// ── Slack identity bridges (best-effort; scopes may be missing) ──

/** users.lookupByEmail → Slack user id (needs users:read.email). */
async function slackIdByEmail(token: string, email: string): Promise<string | null> {
  try {
    const r = await slackPost<SlackOk & { user?: { id?: string } }>(token, 'users.lookupByEmail', { email });
    return r.user?.id ?? null;
  } catch { return null; }
}

/** users.info → profile email (needs users:read.email). */
async function slackUserEmail(token: string, userId: string): Promise<string | null> {
  try {
    const r = await slackPost<SlackOk & { user?: { profile?: { email?: string } } }>(token, 'users.info', { user: userId });
    return r.user?.profile?.email ?? null;
  } catch { return null; }
}
