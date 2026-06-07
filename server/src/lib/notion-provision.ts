// Programmatic provisioning of the NORC workspace databases in Notion.
// Uses raw fetch against the Notion REST API (no @notionhq/client SDK), matching
// the pattern in notion-api.ts. Notion-Version pinned to 2022-06-28.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export type DbKind = 'org' | 'tasks' | 'projects' | 'pipeline' | 'company';

export interface ProvisionedDb {
  kind: DbKind;
  notionDatabaseId: string;
  title: string;
  url: string | null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Extract a Notion page ID from a URL or raw ID and format it as a dashed UUID.
 * Notion page URLs end with a 32-char hex id (optionally after a slug and dash).
 */
export function parsePageId(input: string): string {
  const match = input.match(/([0-9a-fA-F]{32})/);
  if (!match) {
    throw new Error('Could not find a Notion page ID in that input');
  }
  const hex = match[1]!.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Confirm the integration can read the page (i.e. the user shared it). */
export async function checkPageAccess(apiKey: string, pageId: string): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, { headers: headers(apiKey) });
  if (res.ok) return;

  if (res.status === 404 || res.status === 403) {
    throw new Error(
      "NORC can't access that page. In Notion, open the page → ••• → Connections → add your integration, then try again.",
    );
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  const msg = typeof body['message'] === 'string' ? body['message'] : `Notion returned ${res.status}`;
  throw new Error(msg);
}

async function createDatabase(
  apiKey: string,
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<{ id: string; url: string | null }> {
  const res = await fetch(`${NOTION_API}/databases`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      properties,
    }),
  });

  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body['message'] === 'string' ? body['message'] : `Failed to create "${title}"`;
    throw new Error(msg);
  }
  return { id: body['id'] as string, url: (body['url'] as string) ?? null };
}

async function updateDatabase(
  apiKey: string,
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
    method: 'PATCH',
    headers: headers(apiKey),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const msg = typeof body['message'] === 'string' ? body['message'] : 'Failed to add database relations';
    throw new Error(msg);
  }
}

// --- Property schema helpers ---------------------------------------------

const sel = (...names: string[]) => ({ select: { options: names.map(name => ({ name })) } });
const multiSel = (...names: string[]) => ({ multi_select: { options: names.map(name => ({ name })) } });
const text = () => ({ rich_text: {} });
const date = () => ({ date: {} });
const num = () => ({ number: {} });
const relation = (databaseId: string) => ({
  relation: { database_id: databaseId, type: 'single_property', single_property: {} },
});
// A two-way relation: Notion auto-creates the synced reverse property on the
// target database (renamed to something readable in a follow-up PATCH).
const dualRelation = (databaseId: string) => ({
  relation: { database_id: databaseId, type: 'dual_property', dual_property: {} },
});

// Task Status options (incl. 'Draft' for tasks humans are still writing,
// 'Queued' for work waiting in an agent's dispatch queue, and 'Proposed' for
// NORC co-CEO proposals awaiting human validation). Kept as a constant so
// provisioning + the additive patch agree.
export const TASK_STATUS_OPTIONS = ['Draft', 'Backlog', 'Queued', 'In Progress', 'Done', 'Failed', 'Proposed'] as const;

// Statuses NORC never acts on: empty (a half-drafted row — Notion's default for a
// new task), 'Draft' (explicitly parked by a human), and 'Proposed' (a co-CEO
// proposal awaiting validation). Tasks in these states are invisible to every
// executor — the assignment webhook, the triage auto-route, and the scheduler
// (one-shots AND recurring templates). Set Status to 'Backlog' to hand a task over.
export function isInertTaskStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim();
  return s === '' || s === 'Draft' || s === 'Proposed';
}

// --- Phase 1: base (non-relation) property schemas ------------------------

const orgProps: Record<string, unknown> = {
  'Name': { title: {} },
  'Type': sel('Human', 'AI Agent'),
  'Technology': sel('Claude Code', 'Codex', 'Cursor', 'OpenClaw'),
  'Specialty': text(),
  'Status': sel('Available', 'Busy', 'Offline'),
  'System Prompt': text(),
  'Capabilities': multiSel('code', 'design', 'review', 'qa', 'copywriting'),
  'Context Level': sel('task', 'project', 'strategic'),
  'Owner': { people: {} },
  'Last Active': { date: {} },
};

const tasksProps: Record<string, unknown> = {
  'Name': { title: {} },
  'Status': sel(...TASK_STATUS_OPTIONS),
  'KPIs': text(),
  'Agent Output': text(),
  'Pipeline Run ID': text(),
  'Retry Count': { number: {} },
  'Last Checkpoint': text(),
  // Proactive scheduling.
  'Scheduled For': date(),
  'Recurrence': sel('None', 'Daily', 'Weekdays', 'Weekly', 'Monthly'),
  'Repeat Every (days)': num(),
};

const projectsProps: Record<string, unknown> = {
  'Name': { title: {} },
  'Docs': text(),
  'KPIs': text(),
  'Objective': text(),
};

const pipelineProps: Record<string, unknown> = {
  'Pipeline Name': { title: {} },
  'Steps': text(),
  'Trigger Type': sel('mention', 'status-change', 'scheduled'),
};

// Company context — vision / values / strategy. Read-only background that only
// `strategic`-clearance agents see. Active rows are injected; archived ones aren't.
const companyProps: Record<string, unknown> = {
  'Name': { title: {} },
  'Type': sel('Vision', 'Value', 'Strategy', 'Policy'),
  'Status': sel('Active', 'Archived'),
  'Content': text(),
};

/**
 * Create the 4 NORC databases under `parentPageId` and wire their relations.
 * Two-phase: create all databases first (relations need target IDs), then PATCH
 * relation properties once every database ID is known.
 */
export async function provisionWorkspace(apiKey: string, parentPageId: string): Promise<ProvisionedDb[]> {
  // Phase 1 — create databases with non-relation properties.
  const org = await createDatabase(apiKey, parentPageId, 'Org DB', orgProps);
  const tasks = await createDatabase(apiKey, parentPageId, 'Tasks', tasksProps);
  const projects = await createDatabase(apiKey, parentPageId, 'Projects', projectsProps);
  const pipeline = await createDatabase(apiKey, parentPageId, 'Pipeline Config', pipelineProps);
  const company = await createDatabase(apiKey, parentPageId, 'Company', companyProps);

  // Phase 2 — add cross-database relations now that all IDs exist.
  await updateDatabase(apiKey, org.id, { 'Active Tasks': relation(tasks.id) });
  await updateDatabase(apiKey, tasks.id, {
    'Project': relation(projects.id),
    'Assigned To': relation(org.id),
    'Depends On': dualRelation(tasks.id),
  });
  await renameDependsOnReverse(apiKey, tasks.id);
  await updateDatabase(apiKey, projects.id, {
    'Agents': relation(org.id),
    'Company': relation(company.id),
  });

  return [
    { kind: 'org', notionDatabaseId: org.id, title: 'Org DB', url: org.url },
    { kind: 'tasks', notionDatabaseId: tasks.id, title: 'Tasks', url: tasks.url },
    { kind: 'projects', notionDatabaseId: projects.id, title: 'Projects', url: projects.url },
    { kind: 'pipeline', notionDatabaseId: pipeline.id, title: 'Pipeline Config', url: pipeline.url },
    { kind: 'company', notionDatabaseId: company.id, title: 'Company', url: company.url },
  ];
}

/**
 * Additively create the Company DB for a workspace that was provisioned before it
 * existed. Creates the DB + a Projects→Company relation; idempotent at the caller
 * (only invoked when no `company` row exists). Returns the new ProvisionedDb.
 */
export async function provisionCompanyDb(
  apiKey: string,
  parentPageId: string,
  projectsDatabaseId: string | null,
): Promise<ProvisionedDb> {
  const company = await createDatabase(apiKey, parentPageId, 'Company', companyProps);
  if (projectsDatabaseId) {
    await updateDatabase(apiKey, projectsDatabaseId, { 'Company': relation(company.id) });
  }
  return { kind: 'company', notionDatabaseId: company.id, title: 'Company', url: company.url };
}

/**
 * Additively add the proactive-scheduling fields to an already-provisioned Tasks DB:
 * Scheduled For (date), Recurrence (select), Repeat Every (days) (number), and the
 * 'Proposed' Status option. Idempotent — updateDatabase is a PATCH and Notion merges
 * select options by name, so existing options and rows are preserved.
 */
export async function provisionSchedulingFields(apiKey: string, tasksDatabaseId: string): Promise<void> {
  await updateDatabase(apiKey, tasksDatabaseId, {
    'Status': sel(...TASK_STATUS_OPTIONS),
    'Scheduled For': date(),
    'Recurrence': sel('None', 'Daily', 'Weekdays', 'Weekly', 'Monthly'),
    'Repeat Every (days)': num(),
  });
}

async function getDatabase(apiKey: string, databaseId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${NOTION_API}/databases/${databaseId}`, { headers: headers(apiKey) });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body['message'] === 'string' ? body['message'] : `Failed to read database (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

/**
 * Best-effort: Notion auto-names the reverse of the 'Depends On' dual relation
 * (e.g. "Related to Tasks (Depends On)") — rename it to 'Blocks' so the inverse
 * reads naturally on task pages. Failure is tolerated: nothing reads 'Blocks'
 * programmatically.
 */
async function renameDependsOnReverse(apiKey: string, tasksDatabaseId: string): Promise<void> {
  try {
    const body = await getDatabase(apiKey, tasksDatabaseId);
    const props = (body['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    if (props['Blocks']) return; // already renamed
    for (const [name, prop] of Object.entries(props)) {
      if (name === 'Depends On' || prop['type'] !== 'relation') continue;
      const rel = prop['relation'] as Record<string, unknown> | undefined;
      const dual = rel?.['dual_property'] as Record<string, unknown> | undefined;
      if (dual?.['synced_property_name'] === 'Depends On') {
        await updateDatabase(apiKey, tasksDatabaseId, { [name]: { name: 'Blocks' } });
        return;
      }
    }
  } catch { /* cosmetic only */ }
}

/**
 * Additively add task-dependency fields to an already-provisioned Tasks DB:
 * the 'Queued' Status option and a 'Depends On' self-relation (dual — the
 * reverse appears as 'Blocks'). Idempotent: the Status PATCH merges options by
 * name, and the relation is only created when missing.
 */
export async function provisionDependencyFields(apiKey: string, tasksDatabaseId: string): Promise<void> {
  const body = await getDatabase(apiKey, tasksDatabaseId);
  const props = (body['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const patch: Record<string, unknown> = { 'Status': sel(...TASK_STATUS_OPTIONS) };
  if (!props['Depends On']) patch['Depends On'] = dualRelation(tasksDatabaseId);
  await updateDatabase(apiKey, tasksDatabaseId, patch);
  await renameDependsOnReverse(apiKey, tasksDatabaseId);
}
