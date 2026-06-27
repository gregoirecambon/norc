// Shared raw-fetch helpers for the Notion REST API.
// Consolidates the headers()/error-extraction pattern duplicated across
// notion-api.ts, notion-provision.ts and notion-orgdb.ts so the orchestration
// modules have one place to call. Notion-Version pinned to 2022-06-28.
//
// All calls flow through request(), which paces them with a token bucket
// (Notion allows ~3 req/s average) and retries 429s honoring Retry-After —
// bulk operations degrade to latency instead of dropped work.

import { createTokenBucket } from './rate-limiter.js';

export const NOTION_API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';

const bucket = createTokenBucket({ capacity: 3, refillPerSec: 3 });
const MAX_RETRIES = 3;
const RETRYABLE_5XX = new Set([502, 503, 504]);

const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms).unref?.(); });

/** Seconds from a Retry-After header, or null when absent/unparsable. */
function retryAfterSec(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

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
  for (let attempt = 0; ; attempt++) {
    await bucket.acquire();
    const res = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: headers(apiKey),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitSec = retryAfterSec(res) ?? Math.min(8, 2 ** attempt);
      await res.body?.cancel().catch(() => {});
      await sleep(waitSec * 1000);
      continue;
    }
    if (RETRYABLE_5XX.has(res.status) && attempt < 1) {
      await res.body?.cancel().catch(() => {});
      await sleep(1000);
      continue;
    }
    const json = await res.json().catch(() => ({})) as unknown;
    if (!res.ok) {
      throw new Error(errorMessage(json, `Notion ${method} ${path} failed (${res.status})`));
    }
    return json as T;
  }
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

export function notionDelete<T = Record<string, unknown>>(apiKey: string, path: string): Promise<T> {
  return request<T>(apiKey, 'DELETE', path);
}

/** Query a Notion database (POST /databases/:id/query) with an optional filter/sort body. */
export function notionQuery<T = Record<string, unknown>>(apiKey: string, databaseId: string, body: unknown = {}): Promise<T> {
  return request<T>(apiKey, 'POST', `/databases/${databaseId}/query`, body);
}
