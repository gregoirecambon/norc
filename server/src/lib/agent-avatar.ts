// Mirror the agent's Notion page icon into the agents row (avatar blob), so
// Slack posts and the dashboard serve it without a live Notion round-trip —
// presigned-URL expiry and Notion hiccups stop mattering once it's stored.
// Refreshed on every Notion sync; /icons/agents/:id.png serves the bytes.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { emitLog } from './logger.js';
import { readAgentIcon } from './slack-agents.js';

const MAX_ICON_BYTES = 2 * 1024 * 1024;

export interface StoredAvatar { body: Buffer; type: string; at: number | null }

export function storedAvatar(agentId: string): StoredAvatar | null {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!row?.avatar) return null;
  return { body: row.avatar as Buffer, type: row.avatarType ?? 'image/png', at: row.avatarAt ?? null };
}

/**
 * Re-read the Notion icon and persist it. Mirror semantics: an icon that was
 * removed in Notion clears the stored avatar; an unreachable Notion (or a
 * failed download) keeps whatever is stored.
 */
export async function refreshAgentAvatar(agentId: string): Promise<{ hasAvatar: boolean }> {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).all()[0];
  if (!row) return { hasAvatar: false };

  const read = await readAgentIcon(agentId);
  if (read.state === 'unavailable') return { hasAvatar: !!row.avatar };
  if (read.state === 'none') {
    if (row.avatar) {
      db.update(agents).set({ avatar: null, avatarType: null, avatarAt: Date.now() }).where(eq(agents.id, agentId)).run();
      emitLog(`avatar for "${row.name}" cleared — its Notion page has no icon`, 'Slack');
    }
    return { hasAvatar: false };
  }

  try {
    const res = await fetch(read.url, { signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get('content-type') ?? 'image/png';
    if (!res.ok || !type.startsWith('image/')) throw new Error(`upstream ${res.status} (${type})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_ICON_BYTES) throw new Error(`bad size (${body.length} bytes)`);
    db.update(agents).set({ avatar: body, avatarType: type, avatarAt: Date.now() }).where(eq(agents.id, agentId)).run();
    emitLog(`avatar for "${row.name}" saved from its Notion page icon (${Math.max(1, Math.round(body.length / 1024))} KB)`, 'Slack');
    return { hasAvatar: true };
  } catch (err) {
    emitLog(`avatar download for "${row.name}" failed: ${err instanceof Error ? err.message : 'unknown'}${row.avatar ? ' — keeping the stored one' : ''}`, 'Slack');
    return { hasAvatar: !!row.avatar };
  }
}
