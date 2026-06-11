// Per-agent Slack user groups — the Notion trick that makes individual agents
// @mentionable. A user group exists purely as a HANDLE: it holds no members
// (groups can't contain bots), but mentioning @research-agent renders like a
// real mention and produces a message event carrying <!subteam^S…> that the
// Norc app sees in channels it's a member of. Requires a paid Slack plan +
// usergroups:write; failures degrade to the "@Norc <Name> …" text fallback.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, notionIntegration } from '../db/schema.js';
import { emitLog } from './logger.js';
import { getSlack } from './slack-integration.js';
import { slackPost, displayAgentName, type SlackOk } from './slack-client.js';
import { notionGet } from './notion-client.js';

export interface UsergroupResult {
  ok: boolean;
  usergroupId: string | null;
  handle: string | null;
  /** Human-readable reason when the group couldn't be provisioned. */
  warning?: string;
}

/** "Research Agent" → "research-agent" (Slack handle charset). */
export function slugifyHandle(name: string): string {
  return name.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agent';
}

interface UsergroupRow { id: string; handle: string; name: string; date_delete?: number }

async function listUsergroups(botToken: string): Promise<UsergroupRow[]> {
  const r = await slackPost<SlackOk & { usergroups?: UsergroupRow[] }>(botToken, 'usergroups.list', {
    include_disabled: true, include_count: false,
  });
  return r.usergroups ?? [];
}

function friendlyWarning(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('paid_teams_only') || msg.includes('paid_only')) {
    return 'User groups need a paid Slack plan — mention this agent with "@Norc <name> …" instead.';
  }
  if (msg.includes('missing_scope')) {
    return 'The Slack app is missing the usergroups:write scope — reinstall it from the manifest.';
  }
  if (msg.includes('permission_denied') || msg.includes('not_allowed')) {
    return 'Slack denied user-group creation — a workspace admin must allow members to create user groups.';
  }
  return `Couldn't create the Slack handle (${msg}) — mention this agent with "@Norc <name> …" instead.`;
}

/**
 * Ensure the agent has an enabled user group; adopts a pre-existing group with
 * the same handle (idempotent across reinstalls), re-enables a disabled one,
 * and suffixes the handle on collisions with foreign groups.
 */
export async function ensureAgentUsergroup(agentId: string): Promise<UsergroupResult> {
  const agentRow = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!agentRow) return { ok: false, usergroupId: null, handle: null, warning: 'agent not found' };
  const { botToken } = getSlack();
  if (!botToken) return { ok: false, usergroupId: null, handle: null, warning: 'Slack is not connected.' };

  try {
    // Re-enable the group we already provisioned, when there is one.
    if (agentRow.slackUsergroupId) {
      await slackPost(botToken, 'usergroups.enable', { usergroup: agentRow.slackUsergroupId })
        .catch((err: unknown) => {
          // already_enabled is fine; anything else falls through to recreate.
          if (!(err instanceof Error) || !err.message.includes('already_enabled')) throw err;
        });
      return { ok: true, usergroupId: agentRow.slackUsergroupId, handle: agentRow.slackHandle };
    }

    const base = slugifyHandle(agentRow.name);
    const existing = await listUsergroups(botToken).catch(() => [] as UsergroupRow[]);

    // Adopt a same-handle group (ours from a previous install, or one the
    // user created by hand while testing). Case-insensitive — Slack handles are.
    const adopt = existing.find(g => g.handle.toLowerCase() === base.toLowerCase());
    if (adopt) {
      if (adopt.date_delete) await slackPost(botToken, 'usergroups.enable', { usergroup: adopt.id }).catch(() => undefined);
      db.update(agents).set({ slackUsergroupId: adopt.id, slackHandle: adopt.handle }).where(eq(agents.id, agentId)).run();
      emitLog(`adopted Slack handle @${adopt.handle} for "${agentRow.name}"`, 'Slack');
      return { ok: true, usergroupId: adopt.id, handle: adopt.handle };
    }

    // Fresh create. The pre-computed suffix only avoids collisions the list
    // could SEE — usergroups.list can miss groups (failed call, IDP/hidden
    // groups), so *_already_exists from the create itself retries with the
    // next suffix instead of giving up.
    const taken = new Set(existing.map(g => g.handle.toLowerCase()));
    let suffix = 1;
    const candidate = () => (suffix === 1 ? base : `${base}-${suffix}`);
    while (taken.has(candidate()) && suffix < 10) suffix++;

    for (; suffix <= 10; suffix++) {
      const handle = candidate();
      try {
        const created = await slackPost<SlackOk & { usergroup: UsergroupRow }>(botToken, 'usergroups.create', {
          name: suffix === 1 ? displayAgentName(agentRow.name) : `${displayAgentName(agentRow.name)} ${suffix}`,
          handle,
          description: `NORC agent — mention to hand work to ${displayAgentName(agentRow.name)}`,
        });
        const id = created.usergroup.id;
        db.update(agents).set({ slackUsergroupId: id, slackHandle: handle }).where(eq(agents.id, agentId)).run();
        emitLog(`created Slack handle @${handle} for "${agentRow.name}"`, 'Slack');
        return { ok: true, usergroupId: id, handle };
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('already_exists')) throw err; // real failures keep their meaning
      }
    }
    return { ok: false, usergroupId: null, handle: null, warning: `Handles @${base} through @${base}-10 are all taken — free one up in Slack (People → User groups) and re-toggle.` };
  } catch (err) {
    const warning = friendlyWarning(err);
    emitLog(`slack usergroup for "${agentRow.name}": ${warning}`, 'Slack');
    return { ok: false, usergroupId: null, handle: null, warning };
  }
}

// ─── Agent avatars: the Notion Org DB page icon, as Slack icon_url ──────────
// Notion-hosted file icons are presigned S3 URLs that expire (~1h), so the
// cache TTL stays well under that and a fresh URL is fetched per window.
// Emoji icons map to the Twemoji CDN (Slack's icon_url wants an image URL).

const iconCache = new Map<string, { url: string | null; at: number }>();
const ICON_TTL_MS = 10 * 60_000;

function twemojiUrl(emoji: string): string | null {
  const codepoints = [...emoji]
    .map(c => c.codePointAt(0)!)
    .filter(cp => cp !== 0xfe0f) // variation selectors aren't in twemoji filenames
    .map(cp => cp.toString(16));
  if (codepoints.length === 0) return null;
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${codepoints.join('-')}.png`;
}

/** The agent's Slack avatar URL (its Notion Org DB page icon), or null. */
export async function agentSlackIcon(agentId: string): Promise<string | null> {
  const agentRow = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!agentRow?.orgDbPageId) return null;
  const hit = iconCache.get(agentRow.orgDbPageId);
  if (hit && Date.now() - hit.at < ICON_TTL_MS) return hit.url;

  const integration = db.select().from(notionIntegration).all()[0];
  let url: string | null = null;
  if (integration?.status === 'active') {
    try {
      const page = await notionGet<Record<string, unknown>>(integration.apiKey, `/pages/${agentRow.orgDbPageId}`);
      const icon = page['icon'] as Record<string, unknown> | null;
      if (icon?.['type'] === 'external') {
        url = String((icon['external'] as Record<string, unknown>)?.['url'] ?? '') || null;
      } else if (icon?.['type'] === 'file') {
        url = String((icon['file'] as Record<string, unknown>)?.['url'] ?? '') || null;
      } else if (icon?.['type'] === 'emoji' && typeof icon['emoji'] === 'string') {
        url = twemojiUrl(icon['emoji']);
      }
    } catch { /* no icon — Slack falls back to the app avatar */ }
  }
  iconCache.set(agentRow.orgDbPageId, { url, at: Date.now() });
  return url;
}

/** Disable (never delete) the agent's user group — the mapping survives so
 * re-enabling restores the same @handle. */
export async function disableAgentUsergroup(agentId: string): Promise<void> {
  const agentRow = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  const { botToken } = getSlack();
  if (!agentRow?.slackUsergroupId || !botToken) return;
  await slackPost(botToken, 'usergroups.disable', { usergroup: agentRow.slackUsergroupId })
    .catch((err: unknown) => {
      if (!(err instanceof Error) || !err.message.includes('already_disabled')) {
        emitLog(`slack usergroup disable failed for "${agentRow.name}": ${err instanceof Error ? err.message : 'unknown'}`, 'Slack');
      }
    });
  emitLog(`disabled Slack handle @${agentRow.slackHandle ?? ''} for "${agentRow.name}"`, 'Slack');
}
