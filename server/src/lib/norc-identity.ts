// NORC's own identity in the Notion Org DB — the singleton page (Type =
// Orchestrator) that makes the orchestrator @mentionable and assignable like
// any team member. The page id is persisted on notionIntegration (workspace-
// scoped: wiped with DELETE /api/notion, which is the right lifecycle) and
// re-provisioned on demand when the page was deleted/archived in Notion.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration } from '../db/schema.js';
import { getOrgContext } from './notion-orgdb.js';
import { provisionNorcAgent } from './notion-provision.js';
import { notionGet } from './notion-client.js';
import { emitLog } from './logger.js';

/** NORC's Org DB page id (raw, as stored) — null until ensured. Sync sqlite read. */
export function getNorcOrgPageId(): string | null {
  return db.select().from(notionIntegration).all()[0]?.norcOrgPageId ?? null;
}

/**
 * Make sure NORC's Org DB page exists and the pointer is fresh. No-op (null)
 * until the integration is active and the workspace provisioned. Never throws —
 * callers treat null as "NORC has no Notion identity yet".
 */
export async function ensureNorcAgent(): Promise<string | null> {
  const ctx = getOrgContext();
  if (!ctx) return null;
  const integration = db.select().from(notionIntegration).all()[0];
  if (!integration) return null;

  // Pointer already set: verify the page is still live (best-effort; a transient
  // read failure keeps the pointer rather than churning a new page).
  if (integration.norcOrgPageId) {
    try {
      const page = await notionGet<Record<string, unknown>>(ctx.apiKey, `/pages/${integration.norcOrgPageId}`);
      if (page['archived'] !== true && page['in_trash'] !== true) return integration.norcOrgPageId;
      emitLog(`NORC agent page ${integration.norcOrgPageId} was archived — re-provisioning`);
    } catch {
      return integration.norcOrgPageId;
    }
  }

  try {
    const { pageId } = await provisionNorcAgent(ctx.apiKey, ctx.orgDbId);
    db.update(notionIntegration)
      .set({ norcOrgPageId: pageId, updatedAt: Date.now() })
      .where(eq(notionIntegration.id, integration.id))
      .run();
    emitLog(`NORC agent page ensured in Org DB (${pageId})`);
    return pageId;
  } catch (err) {
    emitLog(`NORC agent page provisioning failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}
