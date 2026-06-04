// Sync NORC agents into the Notion Org DB as pages (Type = AI Agent).
// Raw fetch, Notion-Version 2022-06-28 — consistent with notion-api.ts / notion-provision.ts.
// NORC owns only Name/Type/Technology/Status; human-curated fields (Specialty, System Prompt,
// Capabilities, Context Level) are never overwritten on re-sync.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notionIntegration, notionDatabases } from '../db/schema.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function headers(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

const TECHNOLOGY: Record<string, string | null> = {
  'claude-local': 'Claude Code',
  'claude-api': 'Claude Code',
  'codex-local': 'Codex',
  'openclaw': 'OpenClaw',
  'http': null,
};

function statusToNotion(status: string): string {
  // 'Busy' is set later by the dispatch module; here we reflect connectivity only.
  return status === 'connected' ? 'Available' : 'Offline';
}

export interface OrgContext {
  apiKey: string;
  orgDbId: string;
}

/**
 * Returns the API key + Org DB id when the Notion integration is active and the
 * workspace has been provisioned, otherwise null.
 */
export function getOrgContext(): OrgContext | null {
  const integration = db.select().from(notionIntegration).all()[0] ?? null;
  if (!integration || integration.status !== 'active' || integration.workspaceStatus !== 'provisioned') {
    return null;
  }
  const org = db.select().from(notionDatabases).where(eq(notionDatabases.kind, 'org')).all()[0] ?? null;
  if (!org) return null;
  return { apiKey: integration.apiKey, orgDbId: org.notionDatabaseId };
}

export interface AgentLike {
  name: string;
  adapterType: string;
  status: string;
}

function buildProps(agent: AgentLike, opts: { isCreate: boolean }): Record<string, unknown> {
  const props: Record<string, unknown> = {
    'Name': { title: [{ type: 'text', text: { content: agent.name } }] },
    'Type': { select: { name: 'AI Agent' } },
    'Status': { select: { name: statusToNotion(agent.status) } },
  };
  const tech = TECHNOLOGY[agent.adapterType];
  if (tech) props['Technology'] = { select: { name: tech } };
  // Context Level is NORC-seeded once on create, then owned by the human in Notion.
  if (opts.isCreate) props['Context Level'] = { select: { name: 'project' } };
  return props;
}

/** Create the agent's Org DB page, or update it in place when existingPageId is given. */
export async function upsertAgentPage(
  apiKey: string,
  orgDbId: string,
  agent: AgentLike,
  existingPageId?: string,
): Promise<{ pageId: string; url: string | null }> {
  const isCreate = !existingPageId;
  const url = isCreate ? `${NOTION_API}/pages` : `${NOTION_API}/pages/${existingPageId}`;
  const body = isCreate
    ? { parent: { database_id: orgDbId }, properties: buildProps(agent, { isCreate: true }) }
    : { properties: buildProps(agent, { isCreate: false }) };

  const res = await fetch(url, {
    method: isCreate ? 'POST' : 'PATCH',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof json['message'] === 'string' ? json['message'] : `Failed to sync agent "${agent.name}"`;
    throw new Error(msg);
  }
  return { pageId: json['id'] as string, url: (json['url'] as string) ?? null };
}

/** Best-effort archive (Notion trash). Never throws. */
export async function archiveAgentPage(apiKey: string, pageId: string): Promise<void> {
  try {
    await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: 'PATCH',
      headers: headers(apiKey),
      body: JSON.stringify({ archived: true }),
    });
  } catch {
    // best-effort — ignore
  }
}
