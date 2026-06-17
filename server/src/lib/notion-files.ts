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

export type ArtifactKind = 'image' | 'file';

function uploadHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': NOTION_UPLOAD_VERSION,
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
}): Promise<{ fileUploadId: string }> {
  // Step 1 — create the file-upload object (single-part is the default mode).
  const createRes = await fetch(`${NOTION_API}/file_uploads`, {
    method: 'POST',
    headers: uploadHeaders(apiKey, { 'Content-Type': 'application/json' }),
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
    headers: uploadHeaders(apiKey),
    body: form,
  });
  const sendJson = await sendRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!sendRes.ok) throw new Error(errMsg(sendJson, `Notion file_uploads send failed (${sendRes.status})`));
  return { fileUploadId: id };
}

/**
 * Append an image (or generic file) block referencing a completed file_upload to
 * a page. Uses the newer API version. Caption is optional but recommended — it's
 * what a downstream agent and human read to know what the artifact is.
 */
export async function appendArtifactBlock(apiKey: string, pageId: string, args: {
  fileUploadId: string;
  kind: ArtifactKind;
  caption?: string;
}): Promise<void> {
  const caption = args.caption && args.caption.trim()
    ? [{ type: 'text', text: { content: args.caption.trim().slice(0, 2000) } }]
    : [];
  const inner = { type: 'file_upload', file_upload: { id: args.fileUploadId }, caption };
  const block = { object: 'block', type: args.kind, [args.kind]: inner };
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: uploadHeaders(apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ children: [block] }),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(errMsg(json, `Notion append artifact block failed (${res.status})`));
}
