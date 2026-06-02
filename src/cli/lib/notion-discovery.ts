import { Client } from '@notionhq/client';

// After the user duplicates the NORC Notion template, this resolves
// all 4 database IDs from the workspace by searching by title.
export interface DiscoveredDatabases {
  orgDbId: string | null;
  tasksDbId: string | null;
  projectsDbId: string | null;
  pipelineConfigDbId: string | null;
}

const DB_TITLES = {
  orgDbId: ['Org', 'Org DB', 'Organization'],
  tasksDbId: ['Tasks', 'Tasks DB'],
  projectsDbId: ['Projects', 'Projects DB'],
  pipelineConfigDbId: ['Pipeline Config', 'Pipelines'],
};

export async function discoverNotionDatabases(apiKey: string): Promise<DiscoveredDatabases> {
  const notion = new Client({ auth: apiKey });

  let allDatabases: any[] = [];
  let cursor: string | undefined;

  // Paginate through all databases in the workspace
  do {
    const response = await (notion as any).request({
      path: 'search',
      method: 'POST',
      body: {
        filter: { value: 'database', property: 'object' },
        start_cursor: cursor,
        page_size: 100,
      },
    }) as any;

    allDatabases = allDatabases.concat(response.results ?? []);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  const result: DiscoveredDatabases = {
    orgDbId: null,
    tasksDbId: null,
    projectsDbId: null,
    pipelineConfigDbId: null,
  };

  for (const db of allDatabases) {
    const title: string = db.title?.[0]?.plain_text ?? '';

    for (const [key, aliases] of Object.entries(DB_TITLES) as [keyof DiscoveredDatabases, string[]][]) {
      if (!result[key] && aliases.some(alias => title.toLowerCase().includes(alias.toLowerCase()))) {
        result[key] = db.id;
      }
    }
  }

  return result;
}
