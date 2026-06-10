/** Parse an SSE event payload, returning null (and logging) on malformed JSON
 * so a bad frame never crashes the handler. */
export function parseSse<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch (err) {
    console.error('SSE parse error', err);
    return null;
  }
}
