// Shared raw-fetch helpers for the Notion REST API.
// Consolidates the headers()/error-extraction pattern duplicated across
// notion-api.ts, notion-provision.ts and notion-orgdb.ts so the orchestration
// modules have one place to call. Notion-Version pinned to 2022-06-28.

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';

export function headers(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/** Pull a human-readable message out of a Notion error body, with a fallback. */
function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>)['message'] === 'string') {
    return (body as Record<string, unknown>)['message'] as string;
  }
  return fallback;
}

async function request<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: headers(apiKey),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({})) as unknown;
  if (!res.ok) {
    throw new Error(errorMessage(json, `Notion ${method} ${path} failed (${res.status})`));
  }
  return json as T;
}

export function notionGet<T = Record<string, unknown>>(apiKey: string, path: string): Promise<T> {
  return request<T>(apiKey, 'GET', path);
}

export function notionPost<T = Record<string, unknown>>(apiKey: string, path: string, body: unknown): Promise<T> {
  return request<T>(apiKey, 'POST', path, body);
}

export function notionPatch<T = Record<string, unknown>>(apiKey: string, path: string, body: unknown): Promise<T> {
  return request<T>(apiKey, 'PATCH', path, body);
}
