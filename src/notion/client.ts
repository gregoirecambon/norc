import { Client } from '@notionhq/client';
import PQueue from 'p-queue';
import type { NotionTask, NotionProject } from '../types/index.js';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Notion allows 3 requests/second per integration
const queue = new PQueue({ concurrency: 2, intervalCap: 3, interval: 1000 });

export async function notionRequest<T>(fn: () => Promise<T>): Promise<T> {
  return queue.add(fn) as Promise<T>;
}

export async function getTask(pageId: string): Promise<NotionTask> {
  const page = await notionRequest(() =>
    notion.pages.retrieve({ page_id: pageId })
  ) as any;

  const props = page.properties;
  return {
    id: page.id,
    name: props.Name?.title?.[0]?.plain_text ?? '',
    status: props.Status?.select?.name ?? '',
    projectId: props.Project?.relation?.[0]?.id ?? null,
    assignedAgent: props['Assigned Agent']?.select?.name ?? null,
    kpis: props.KPIs?.rich_text?.[0]?.plain_text ?? '',
    agentOutput: props['Agent Output']?.rich_text?.[0]?.plain_text ?? '',
    pipelineRunId: props['Pipeline Run ID']?.rich_text?.[0]?.plain_text ?? null,
    retryCount: props['Retry Count']?.number ?? 0,
    lastCheckpoint: props['Last Checkpoint']?.rich_text?.[0]?.plain_text ?? null,
  };
}

export async function getProject(pageId: string): Promise<NotionProject> {
  const page = await notionRequest(() =>
    notion.pages.retrieve({ page_id: pageId })
  ) as any;

  const props = page.properties;
  return {
    id: page.id,
    name: props.Name?.title?.[0]?.plain_text ?? '',
    docs: props.Docs?.rich_text?.[0]?.plain_text ?? '',
    kpis: props.KPIs?.rich_text?.[0]?.plain_text ?? '',
    objective: props.Objective?.rich_text?.[0]?.plain_text ?? '',
  };
}

export async function updateTaskStatus(
  pageId: string,
  status: 'In Progress' | 'Done' | 'Failed' | 'Ready'
): Promise<void> {
  await notionRequest(() =>
    notion.pages.update({
      page_id: pageId,
      properties: { Status: { select: { name: status } } },
    })
  );
}

export async function writeCheckpoint(
  pageId: string,
  checkpoint: object
): Promise<void> {
  await notionRequest(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        'Last Checkpoint': {
          rich_text: [{ text: { content: JSON.stringify(checkpoint) } }],
        },
      },
    })
  );
}

export async function appendComment(pageId: string, text: string): Promise<void> {
  await notionRequest(() =>
    notion.comments.create({
      parent: { page_id: pageId },
      rich_text: [{ text: { content: text } }],
    })
  );
}

export async function incrementRetryCount(pageId: string, currentCount: number): Promise<void> {
  await notionRequest(() =>
    notion.pages.update({
      page_id: pageId,
      properties: { 'Retry Count': { number: currentCount + 1 } },
    })
  );
}

// Fetch all agent pages from the Org DB and return lightweight records
export async function getOrgDbAgents(): Promise<Array<{ id: string; name: string; specialty: string; contextLevel: string }>> {
  const orgDbId = process.env.NOTION_ORG_DB_ID;
  if (!orgDbId) return [];

  // SDK v5 removed databases.query() — use raw request instead
  const response = await notionRequest(() =>
    (notion as any).request({
      path: `databases/${orgDbId}/query`,
      method: 'POST',
      body: { filter: { property: 'Type', select: { equals: 'AI Agent' } } },
    })
  ) as any;

  return (response.results ?? []).map((page: any) => ({
    id: page.id,
    name: page.properties.Name?.title?.[0]?.plain_text ?? '',
    specialty: page.properties.Specialty?.rich_text?.[0]?.plain_text ?? '',
    contextLevel: page.properties['Context Level']?.select?.name ?? 'project',
  }));
}

export async function getOrgDbAgentByName(name: string): Promise<any | null> {
  const agents = await getOrgDbAgents();
  return agents.find(a => a.name.toLowerCase().includes(name.toLowerCase())) ?? null;
}

export async function updateAgentLastActive(pageId: string): Promise<void> {
  await notionRequest(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        'Last Active': { date: { start: new Date().toISOString() } },
      },
    })
  ).catch(() => {}); // non-critical
}
