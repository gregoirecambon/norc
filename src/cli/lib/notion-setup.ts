import { Client } from '@notionhq/client';

// Creates all 4 NORC databases under a given parent page.
// Returns the database IDs.
export interface CreatedDatabases {
  orgDbId: string;
  tasksDbId: string;
  projectsDbId: string;
  pipelineConfigDbId: string;
}

// SDK v5 changed the databases.create type signature — use raw request for full control
async function dbCreate(notion: Client, body: object): Promise<string> {
  const db = await (notion as any).request({
    path: 'databases',
    method: 'POST',
    body,
  }) as any;
  return db.id;
}

export async function createNorcDatabases(
  apiKey: string,
  parentPageId: string
): Promise<CreatedDatabases> {
  const notion = new Client({ auth: apiKey });
  const parent = { type: 'page_id', page_id: parentPageId };

  const [orgDbId, tasksDbId, projectsDbId, pipelineConfigDbId] = await Promise.all([
    dbCreate(notion, {
      parent,
      title: [{ type: 'text', text: { content: 'Org DB' } }],
      properties: {
        Name:            { title: {} },
        Type:            { select: { options: [{ name: 'Human', color: 'blue' }, { name: 'AI Agent', color: 'green' }] } },
        Technology:      { select: { options: [{ name: 'Claude Code' }, { name: 'Codex' }, { name: 'Cursor' }, { name: 'OpenClaw' }] } },
        Specialty:       { rich_text: {} },
        Status:          { select: { options: [{ name: 'Available', color: 'green' }, { name: 'Busy', color: 'yellow' }, { name: 'Offline', color: 'gray' }] } },
        'System Prompt': { rich_text: {} },
        Capabilities:    { multi_select: { options: [{ name: 'code' }, { name: 'design' }, { name: 'review' }, { name: 'qa' }, { name: 'copywriting' }] } },
        'Context Level': { select: { options: [{ name: 'task' }, { name: 'project' }, { name: 'strategic' }] } },
        'Last Active':   { date: {} },
        Owner:           { people: {} },
      },
    }),
    dbCreate(notion, {
      parent,
      title: [{ type: 'text', text: { content: 'Tasks' } }],
      properties: {
        Name:              { title: {} },
        Status:            { select: { options: [{ name: 'Backlog', color: 'gray' }, { name: 'Ready', color: 'blue' }, { name: 'In Progress', color: 'yellow' }, { name: 'Done', color: 'green' }, { name: 'Failed', color: 'red' }] } },
        'Assigned Agent':  { select: {} },
        KPIs:              { rich_text: {} },
        'Agent Output':    { rich_text: {} },
        'Pipeline Run ID': { rich_text: {} },
        'Retry Count':     { number: {} },
        'Last Checkpoint': { rich_text: {} },
      },
    }),
    dbCreate(notion, {
      parent,
      title: [{ type: 'text', text: { content: 'Projects' } }],
      properties: {
        Name:      { title: {} },
        Docs:      { rich_text: {} },
        KPIs:      { rich_text: {} },
        Objective: { rich_text: {} },
      },
    }),
    dbCreate(notion, {
      parent,
      title: [{ type: 'text', text: { content: 'Pipeline Config' } }],
      properties: {
        Name:             { title: {} },
        Steps:            { rich_text: {} },
        'Trigger Status': { select: { options: [{ name: 'Ready' }] } },
      },
    }),
  ]);

  return { orgDbId, tasksDbId, projectsDbId, pipelineConfigDbId };
}

// Register a webhook on the Tasks database
export async function registerWebhook(
  apiKey: string,
  tasksDbId: string,
  publicUrl: string,
  webhookSecret: string
): Promise<string | null> {
  // Notion's webhook API is accessed via raw request
  const notion = new Client({ auth: apiKey });
  try {
    const response = await (notion as any).request({
      path: 'webhooks',
      method: 'POST',
      body: {
        url: `${publicUrl}/webhooks/notion`,
        event_types: ['page.updated', 'comment.created'],
        filters: [{ type: 'database', database_id: tasksDbId }],
        signing_secret: webhookSecret,
      },
    }) as any;
    return response.id ?? null;
  } catch {
    // Webhook registration may fail if Notion's API doesn't support it on this plan
    // User can register manually in Notion developer console
    return null;
  }
}
