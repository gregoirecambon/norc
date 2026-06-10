// Per-agent Slack user groups — the Notion trick that makes individual agents
// @mentionable. A user group exists purely as a HANDLE: it holds no members
// (groups can't contain bots), but mentioning @research-agent renders like a
// real mention and produces a message event carrying <!subteam^S…> that the
// Norc app sees in channels it's a member of. Requires a paid Slack plan +
// usergroups:write; failures degrade to the "@Norc <Name> …" text fallback.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { emitLog } from './logger.js';
import { getSlack } from './slack-integration.js';
import { slackPost, type SlackOk } from './slack-client.js';

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

    // Adopt a same-handle group (ours from a previous install).
    const adopt = existing.find(g => g.handle === base);
    if (adopt) {
      if (adopt.date_delete) await slackPost(botToken, 'usergroups.enable', { usergroup: adopt.id }).catch(() => undefined);
      db.update(agents).set({ slackUsergroupId: adopt.id, slackHandle: adopt.handle }).where(eq(agents.id, agentId)).run();
      emitLog(`adopted Slack handle @${adopt.handle} for "${agentRow.name}"`, 'Slack');
      return { ok: true, usergroupId: adopt.id, handle: adopt.handle };
    }

    // Fresh create, suffixing on collision with a foreign handle.
    const taken = new Set(existing.map(g => g.handle));
    let handle = base;
    for (let i = 2; taken.has(handle) && i < 10; i++) handle = `${base}-${i}`;
    const created = await slackPost<SlackOk & { usergroup: UsergroupRow }>(botToken, 'usergroups.create', {
      name: agentRow.name,
      handle,
      description: `NORC agent — mention to hand work to ${agentRow.name}`,
    });
    const id = created.usergroup.id;
    db.update(agents).set({ slackUsergroupId: id, slackHandle: handle }).where(eq(agents.id, agentId)).run();
    emitLog(`created Slack handle @${handle} for "${agentRow.name}"`, 'Slack');
    return { ok: true, usergroupId: id, handle };
  } catch (err) {
    const warning = friendlyWarning(err);
    emitLog(`slack usergroup for "${agentRow.name}": ${warning}`, 'Slack');
    return { ok: false, usergroupId: null, handle: null, warning };
  }
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
