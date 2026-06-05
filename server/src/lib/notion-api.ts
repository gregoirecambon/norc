export interface NotionBotInfo {
  workspaceName: string;
  botName: string;
  botUserId: string | null;
}

export async function validateNotionKey(apiKey: string): Promise<NotionBotInfo> {
  const res = await fetch('https://api.notion.com/v1/users/me', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': '2022-06-28',
    },
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const msg = typeof body['message'] === 'string' ? body['message'] : 'Invalid API key';
    throw new Error(msg);
  }

  const bot = body['bot'] as Record<string, unknown> | undefined;
  const workspaceName = typeof bot?.['workspace_name'] === 'string' ? bot['workspace_name'] : 'Unknown workspace';
  const botName = typeof body['name'] === 'string' ? body['name'] : 'Unknown bot';
  // `GET /users/me` with an integration token returns that bot's own user object;
  // the top-level `id` is the bot user id we match incoming comment authors against.
  const botUserId = typeof body['id'] === 'string' ? body['id'] : null;

  return { workspaceName, botName, botUserId };
}
