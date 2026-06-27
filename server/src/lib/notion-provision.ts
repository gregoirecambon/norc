// Programmatic provisioning of the NORC workspace databases in Notion.
// Uses raw fetch against the Notion REST API (no @notionhq/client SDK), matching
// the pattern in notion-api.ts. Notion-Version pinned to 2022-06-28.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// 'pipeline' is the dormant legacy kind (the old "Pipeline Config" DB); kept in
// the union so existing rows still type-check until they're upgraded to 'chores'.
export type DbKind = 'org' | 'tasks' | 'projects' | 'pipeline' | 'chores' | 'company';

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
  await patchDatabase(apiKey, databaseId, { properties });
}

/** PATCH a database's title and/or properties. Property entries can add (new key →
 * type), rename (existing key → `{name}`), or remove (key → null). */
async function patchDatabase(
  apiKey: string,
  databaseId: string,
  body: { title?: unknown; properties?: Record<string, unknown> },
): Promise<void> {
  const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
    method: 'PATCH',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({})) as Record<string, unknown>;
    const msg = typeof b['message'] === 'string' ? b['message'] : 'Failed to update database';
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
// 'Blocked' parks a task an agent couldn't finish for lack of info — it waits on a
// human and NORC never re-dispatches it (inert) until the human hands it back.
export const TASK_STATUS_OPTIONS = ['Draft', 'Backlog', 'Queued', 'In Progress', 'Done', 'Failed', 'Proposed', 'Blocked'] as const;

// Statuses NORC never acts on: empty (a half-drafted row — Notion's default for a
// new task), 'Draft' (explicitly parked by a human), 'Proposed' (a co-CEO proposal
// awaiting validation), and 'Blocked' (an agent parked it pending human input).
// Tasks in these states are invisible to every executor — the assignment webhook,
// the triage auto-route, and the scheduler (one-shots AND recurring templates).
// Set Status to 'Backlog' to hand a task over.
export function isInertTaskStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').trim();
  return s === '' || s === 'Draft' || s === 'Proposed' || s === 'Blocked';
}

// --- Phase 1: base (non-relation) property schemas ------------------------

// Org DB member types. 'Orchestrator' is NORC's own singleton page — kept out of
// 'AI Agent' so Type-based sweeps (the humans roster, the agents sync) never pick
// it up, and out of 'Human' so it's never treated as a person.
export const ORG_TYPE_OPTIONS = ['Human', 'AI Agent', 'Orchestrator'] as const;

const orgProps: Record<string, unknown> = {
  'Name': { title: {} },
  'Type': sel(...ORG_TYPE_OPTIONS),
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
  // Slack channel bound to this project (channel ID, e.g. C0123456789).
  // Task completions are summarized there; agents can post to it via the
  // /slack run endpoint. Empty = no Slack reporting for this project.
  'Slack Channel ID': text(),
};

// Chores DB — the Notion mirror of the on-disk chore.md process definitions. The
// full step spec lives in the page BODY (one fenced code block, a faithful
// round-trip); these properties mirror the frontmatter for human filtering, plus
// two sync-bookkeeping columns (Sync State display + Sync Hash baseline) so the
// reconciler keeps state in Notion, not a SQLite table.
const choresExtraProps: Record<string, unknown> = {
  'Description':    text(),
  'Trigger':        sel('mention', 'status-change', 'scheduled'),
  'Approval':       sel('auto', 'cast'),
  'Min Confidence': num(),
  'Inputs':         text(),
  'Sync State':     sel('synced', 'conflict', 'disk-only'),
  'Sync Hash':      text(),
};
const choresProps: Record<string, unknown> = {
  'Chore': { title: {} },   // = the chore id
  ...choresExtraProps,
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
  const chores = await createDatabase(apiKey, parentPageId, 'Chores', choresProps);
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
    { kind: 'chores', notionDatabaseId: chores.id, title: 'Chores', url: chores.url },
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
 * Provide the Chores DB (the Notion mirror of the on-disk chore.md files). For a
 * workspace whose dormant "Pipeline Config" DB still exists, RENAME it in place →
 * "Chores": rename its title property ('Pipeline Name' → 'Chore'), drop the unused
 * legacy props, and add the chore columns — so the dormant DB is reused, not
 * orphaned. Otherwise create a fresh "Chores" DB. Idempotent at the caller.
 */
export async function provisionChoresDb(
  apiKey: string,
  parentPageId: string,
  existingPipelineDbId?: string | null,
): Promise<ProvisionedDb> {
  if (existingPipelineDbId) {
    await patchDatabase(apiKey, existingPipelineDbId, {
      title: [{ type: 'text', text: { content: 'Chores' } }],
      properties: {
        'Pipeline Name': { name: 'Chore' }, // rename the title property
        'Steps': null,                      // drop the unused legacy columns
        'Trigger Type': null,
        ...choresExtraProps,
      },
    });
    return { kind: 'chores', notionDatabaseId: existingPipelineDbId, title: 'Chores', url: null };
  }
  const chores = await createDatabase(apiKey, parentPageId, 'Chores', choresProps);
  return { kind: 'chores', notionDatabaseId: chores.id, title: 'Chores', url: chores.url };
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

/**
 * Additively add the 'Blocked' Status option to an already-provisioned Tasks DB.
 * Idempotent — updateDatabase is a PATCH and Notion merges select options by name,
 * so existing options and rows are preserved.
 */
export async function provisionBlockedStatus(apiKey: string, tasksDatabaseId: string): Promise<void> {
  await updateDatabase(apiKey, tasksDatabaseId, { 'Status': sel(...TASK_STATUS_OPTIONS) });
}

/**
 * Additively add the 'Slack Channel ID' field to an already-provisioned
 * Projects DB. Idempotent — re-PATCHing an existing rich_text property is a
 * no-op for Notion.
 */
export async function provisionSlackChannelField(apiKey: string, projectsDatabaseId: string): Promise<void> {
  await updateDatabase(apiKey, projectsDatabaseId, { 'Slack Channel ID': text() });
}

/**
 * Ensure NORC itself exists in the Org DB as a singleton page (Type =
 * Orchestrator) so it can be @mentioned and assigned like any team member.
 * Idempotent and self-healing: the Type option merge is an additive PATCH, an
 * existing Orchestrator page is adopted (heals a lost sqlite pointer), and a
 * page is created only when none exists.
 */
export async function provisionNorcAgent(apiKey: string, orgDbId: string): Promise<{ pageId: string; url: string | null }> {
  // Additive select merge — upgrades workspaces provisioned before 'Orchestrator' existed.
  await updateDatabase(apiKey, orgDbId, { 'Type': sel(...ORG_TYPE_OPTIONS) });

  // Adopt an existing Orchestrator page when there is one.
  const queryRes = await fetch(`${NOTION_API}/databases/${orgDbId}/query`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ filter: { property: 'Type', select: { equals: 'Orchestrator' } }, page_size: 1 }),
  });
  const queryBody = await queryRes.json().catch(() => ({})) as Record<string, unknown>;
  if (queryRes.ok && Array.isArray(queryBody['results']) && queryBody['results'].length > 0) {
    const page = queryBody['results'][0] as Record<string, unknown>;
    return { pageId: page['id'] as string, url: (page['url'] as string) ?? null };
  }

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      parent: { database_id: orgDbId },
      properties: {
        'Name': { title: [{ type: 'text', text: { content: 'NORC' } }] },
        'Type': { select: { name: 'Orchestrator' } },
        'Status': { select: { name: 'Available' } },
        'Specialty': { rich_text: [{ type: 'text', text: { content: 'Task orchestration, triage, workspace operations' } }] },
      },
    }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof body['message'] === 'string' ? body['message'] : 'Failed to create the NORC agent page';
    throw new Error(msg);
  }
  return { pageId: body['id'] as string, url: (body['url'] as string) ?? null };
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
