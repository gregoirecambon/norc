// Shared raw-fetch helpers for the Slack Web API — same shape as
// notion-client.ts (no SDK). All calls flow through request(), which paces
// them with a token bucket (chat.postMessage allows ~1 msg/sec/channel;
// Tier-3 methods ~50/min) and retries 429s honoring Retry-After.
//
// Slack-specific quirk: the Web API returns HTTP 200 with { ok: false,
// error: '...' } on most failures — request() converts that to a throw so
// callers handle one error path.

import { createTokenBucket } from './rate-limiter.js';

export const SLACK_API = 'https://slack.com/api';

const bucket = createTokenBucket({ capacity: 3, refillPerSec: 1 });
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms).unref?.(); });

function retryAfterSec(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface SlackOk { ok: boolean; error?: string; [key: string]: unknown }

async function request<T extends SlackOk>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await bucket.acquire();
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec(res) ?? Math.min(8, 2 ** attempt);
      await res.body?.cancel().catch(() => {});
      await sleep(waitSec * 1000);
      continue;
    }
    const json = await res.json().catch(() => ({})) as T;
    if (!res.ok) throw new Error(`Slack ${method} failed (${res.status})`);
    if (!json.ok) {
      // ratelimited arrives as ok:false on some methods — same backoff path.
      if (json.error === 'ratelimited' && attempt < MAX_RETRIES) {
        await sleep(Math.min(8, 2 ** attempt) * 1000);
        continue;
      }
      throw new Error(`Slack ${method} failed: ${json.error ?? 'unknown_error'}`);
    }
    return json;
  }
}

export function slackPost<T extends SlackOk = SlackOk>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  return request<T>(token, method, body);
}

/** auth.test — validates a bot token and identifies the workspace + bot user. */
export async function slackAuthTest(token: string): Promise<{
  teamId: string; teamName: string; botUserId: string; botName: string; appId: string | null;
}> {
  const r = await request<SlackOk & {
    team_id: string; team: string; user_id: string; user: string; bot_id?: string;
  }>(token, 'auth.test');
  // bot_id → app id needs bots.info; app id is optional metadata, fetched best-effort.
  let appId: string | null = null;
  if (r.bot_id) {
    try {
      const info = await request<SlackOk & { bot: { app_id?: string } }>(token, 'bots.info', { bot: r.bot_id });
      appId = info.bot?.app_id ?? null;
    } catch { /* cosmetic only */ }
  }
  return { teamId: r.team_id, teamName: r.team, botUserId: r.user_id, botName: r.user, appId };
}

/**
 * Post a message into a channel (optionally a thread) under an agent's own
 * name/avatar. Requires chat:write + chat:write.customize. Note: username
 * overrides don't apply in DMs — there the message posts as the app.
 */
export async function postAsAgent(token: string, opts: {
  channel: string;
  text: string;
  threadTs?: string | null;
  agentName?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}): Promise<{ channel: string; ts: string }> {
  const base = {
    channel: opts.channel,
    text: opts.text,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    unfurl_links: false,
  };
  const customized = !!(opts.agentName || opts.iconUrl || opts.iconEmoji);
  try {
    const r = await request<SlackOk & { channel: string; ts: string }>(token, 'chat.postMessage', {
      ...base,
      ...(opts.agentName ? { username: opts.agentName } : {}),
      ...(opts.iconUrl ? { icon_url: opts.iconUrl } : {}),
      ...(opts.iconEmoji ? { icon_emoji: opts.iconEmoji } : {}),
    });
    return { channel: r.channel, ts: r.ts };
  } catch (err) {
    // Delivery beats cosmetics: if Slack rejected the customized post (DM
    // conversations, an icon URL it dislikes, a missing customize scope),
    // retry once as the plain app with the agent's name inlined.
    if (!customized) throw err;
    const r = await request<SlackOk & { channel: string; ts: string }>(token, 'chat.postMessage', {
      ...base,
      ...(opts.agentName ? { text: `*${opts.agentName}:* ${opts.text}` } : {}),
    });
    return { channel: r.channel, ts: r.ts };
  }
}

export interface SlackMessage {
  ts: string;
  threadTs: string | null;
  userId: string | null;     // human author (null for bot messages)
  botId: string | null;
  username: string | null;   // display override on bot messages (our agents)
  text: string;
}

/** conversations.replies — full thread history, oldest first. */
export async function fetchThreadReplies(token: string, channel: string, threadTs: string, limit = 50): Promise<SlackMessage[]> {
  const r = await request<SlackOk & { messages?: Array<Record<string, unknown>> }>(token, 'conversations.replies', {
    channel, ts: threadTs, limit,
  });
  return (r.messages ?? []).map(m => ({
    ts: String(m['ts'] ?? ''),
    threadTs: typeof m['thread_ts'] === 'string' ? m['thread_ts'] : null,
    userId: typeof m['user'] === 'string' ? m['user'] : null,
    botId: typeof m['bot_id'] === 'string' ? m['bot_id'] : null,
    username: typeof m['username'] === 'string' ? m['username'] : null,
    text: typeof m['text'] === 'string' ? m['text'] : '',
  }));
}

/** conversations.info — channel metadata; is_member gates agent sends. */
export async function conversationsInfo(token: string, channel: string): Promise<{
  id: string; name: string | null; isMember: boolean; isIm: boolean; isPrivate: boolean;
}> {
  const r = await request<SlackOk & { channel: Record<string, unknown> }>(token, 'conversations.info', { channel });
  const c = r.channel ?? {};
  return {
    id: String(c['id'] ?? channel),
    name: typeof c['name'] === 'string' ? c['name'] : null,
    isMember: c['is_member'] === true,
    isIm: c['is_im'] === true || c['is_mpim'] === true,
    isPrivate: c['is_group'] === true || c['is_private'] === true,
  };
}

/** conversations.join — the app adds itself to a PUBLIC channel (channels:join).
 * Private channels always reject this: Slack only admits apps a member invited. */
export async function joinChannel(token: string, channel: string): Promise<void> {
  await request(token, 'conversations.join', { channel });
}

export type MembershipResult =
  | { ok: true; name: string | null; joined: boolean }
  | { ok: false; reason: 'private' | 'error'; name: string | null; message: string };

/**
 * Make sure the app can post in a channel, self-joining public channels it
 * isn't in yet. Private channels can't be self-joined (platform rule) — the
 * result carries a human-actionable message ("/invite @Norc") instead.
 */
export async function ensureChannelMembership(token: string, channel: string): Promise<MembershipResult> {
  let info;
  try {
    info = await conversationsInfo(token, channel);
  } catch (err) {
    // channel_not_found on a private channel the app can't even SEE — same
    // remedy as not being a member: someone inside must invite it.
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.includes('channel_not_found')) {
      return { ok: false, reason: 'private', name: null, message: `I can't access ${channel} — it's private (or doesn't exist). Ask a member to run /invite @Norc there.` };
    }
    return { ok: false, reason: 'error', name: null, message: msg };
  }
  if (info.isMember || info.isIm) return { ok: true, name: info.name, joined: false };
  if (info.isPrivate) {
    return {
      ok: false, reason: 'private', name: info.name,
      message: `${info.name ? '#' + info.name : channel} is private — apps can't join those by themselves. Ask a member to run /invite @Norc there.`,
    };
  }
  try {
    await joinChannel(token, channel);
    return { ok: true, name: info.name, joined: true };
  } catch (err) {
    return { ok: false, reason: 'error', name: info.name, message: err instanceof Error ? err.message : 'join failed' };
  }
}

/** users.info — display name for thread-context rendering. Cached by caller. */
export async function slackUserName(token: string, userId: string): Promise<string | null> {
  try {
    const r = await request<SlackOk & { user?: { profile?: { display_name?: string; real_name?: string }; name?: string } }>(
      token, 'users.info', { user: userId });
    return r.user?.profile?.display_name || r.user?.profile?.real_name || r.user?.name || null;
  } catch {
    return null;
  }
}
