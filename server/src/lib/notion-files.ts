// Notion File Upload API — store an agent's result file (image / document) in
// Notion and attach it to a task page as an image/file block, so a dependent
// task's agent can pick it up.
//
// This needs a NEWER Notion-Version than the rest of NORC: notion-client.ts pins
// 2022-06-28, but the File Upload API and the `file_upload` block reference only
// exist on a recent version. So these calls are self-contained (their own fetch +
// version header) rather than routed through notion-client. READS of the
// resulting block stay on 2022-06-28 — Notion returns a standard signed `file.url`
// regardless of how the file was uploaded — so mediaBlockInfo/readPageMarkdown
// pick the URL up unchanged.
//
// Small-file path only: single-part upload, <20 MB (the limit the caller enforces).

import { NOTION_API } from './notion-client.js';

/** The File Upload API + file_upload block reference require a recent API version. */
export const NOTION_UPLOAD_VERSION = '2025-09-03';

/**
 * HTML blocks — an `embed` block backed by an uploaded `.html` file, which Notion
 * renders interactively in a sandboxed iframe (same thing the app's /html command
 * and the Notion MCP agents produce) — shipped with Notion 3.6 (July 2026) and need
 * a newer version than plain image/file uploads: both a `text/html` file upload and
 * an `embed.file_upload` block are rejected on 2025-09-03. Scoped to the HTML path so
 * the proven image/file upload flow keeps its pinned version untouched.
 */
export const NOTION_HTML_VERSION = '2026-03-11';

export type ArtifactKind = 'image' | 'file' | 'embed';

function uploadHeaders(apiKey: string, version: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': version,
    ...(extra ?? {}),
  };
}

function errMsg(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>)['message'] === 'string') {
    return (body as Record<string, unknown>)['message'] as string;
  }
  return fallback;
}

/**
 * Upload bytes to Notion and return the file_upload id. Two steps:
 *   1) POST /v1/file_uploads                       → { id, upload_url }
 *   2) POST {upload_url}  (multipart, field "file") → status "uploaded"
 * The id must be attached to a block/page within ~1 hour or it expires — the
 * caller appends the block immediately after.
 */
export async function uploadFileToNotion(apiKey: string, args: {
  filename: string;
  bytes: Buffer;
  contentType: string;
  /** Override the API version — e.g. NOTION_HTML_VERSION for a text/html upload. */
  version?: string;
}): Promise<{ fileUploadId: string }> {
  const version = args.version ?? NOTION_UPLOAD_VERSION;
  // Step 1 — create the file-upload object (single-part is the default mode).
  const createRes = await fetch(`${NOTION_API}/file_uploads`, {
    method: 'POST',
    headers: uploadHeaders(apiKey, version, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ filename: args.filename, content_type: args.contentType }),
  });
  const createJson = await createRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!createRes.ok) throw new Error(errMsg(createJson, `Notion file_uploads create failed (${createRes.status})`));
  const id = typeof createJson['id'] === 'string' ? createJson['id'] : '';
  if (!id) throw new Error('Notion file_uploads create returned no id');
  const uploadUrl = typeof createJson['upload_url'] === 'string'
    ? createJson['upload_url'] as string
    : `${NOTION_API}/file_uploads/${id}/send`;

  // Step 2 — send the bytes as multipart/form-data (field name: "file"). Let
  // fetch derive the multipart Content-Type + boundary from the FormData body.
  const form = new FormData();
  form.append('file', new Blob([args.bytes], { type: args.contentType }), args.filename);
  const sendRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: uploadHeaders(apiKey, version),
    body: form,
  });
  const sendJson = await sendRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!sendRes.ok) throw new Error(errMsg(sendJson, `Notion file_uploads send failed (${sendRes.status})`));
  return { fileUploadId: id };
}

/**
 * Append a block referencing a completed file_upload to a page. Uses the newer API
 * version. Caption is optional but recommended — it's what a downstream agent and
 * human read to know what the artifact is.
 *
 * The block shape is identical across kinds — `{ type: kind, [kind]: { type:
 * 'file_upload', file_upload: { id }, caption } }` — so `'embed'` (an HTML block:
 * an uploaded .html rendered interactively in a sandboxed iframe) rides the same
 * path as `'image'`/`'file'`. Pass `version: NOTION_HTML_VERSION` for the embed kind.
 */
export async function appendArtifactBlock(apiKey: string, pageId: string, args: {
  fileUploadId: string;
  kind: ArtifactKind;
  caption?: string;
  /** Override the API version — NOTION_HTML_VERSION is required for kind 'embed'. */
  version?: string;
}): Promise<void> {
  const version = args.version ?? NOTION_UPLOAD_VERSION;
  const caption = args.caption && args.caption.trim()
    ? [{ type: 'text', text: { content: args.caption.trim().slice(0, 2000) } }]
    : [];
  const inner = { type: 'file_upload', file_upload: { id: args.fileUploadId }, caption };
  const block = { object: 'block', type: args.kind, [args.kind]: inner };
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: uploadHeaders(apiKey, version, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ children: [block] }),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(errMsg(json, `Notion append artifact block failed (${res.status})`));
}
