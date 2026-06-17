import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadFileToNotion, appendArtifactBlock, NOTION_UPLOAD_VERSION } from '../lib/notion-files.js';

const calls: { url: string; init: { method?: string; headers: Record<string, string>; body: unknown } }[] = [];
const origFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }): void {
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: unknown };
    calls.push({ url: String(url), init: { method: i.method, headers: i.headers ?? {}, body: i.body } });
    const r = handler(String(url));
    return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => ({ ok: true, status: 200, body });
const fail = (status: number, body: unknown) => ({ ok: false, status, body });

beforeEach(() => { calls.length = 0; });
afterEach(() => { globalThis.fetch = origFetch; });

describe('uploadFileToNotion', () => {
  it('creates then sends, returning the file_upload id', async () => {
    mockFetch(url => {
      if (url.endsWith('/file_uploads')) return ok({ id: 'fu_1', upload_url: 'https://api.notion.com/v1/file_uploads/fu_1/send' });
      if (url.endsWith('/file_uploads/fu_1/send')) return ok({ id: 'fu_1', status: 'uploaded' });
      throw new Error(`unexpected ${url}`);
    });
    const { fileUploadId } = await uploadFileToNotion('key', { filename: 'a.png', bytes: Buffer.from('hello'), contentType: 'image/png' });
    expect(fileUploadId).toBe('fu_1');
    expect(calls).toHaveLength(2);
    // create: JSON body + the newer upload version
    expect(calls[0]!.init.headers['Notion-Version']).toBe(NOTION_UPLOAD_VERSION);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ filename: 'a.png', content_type: 'image/png' });
    // send: multipart FormData body, and WE do not set a JSON content-type (fetch derives the boundary)
    expect(calls[1]!.init.body).toBeInstanceOf(FormData);
    expect(calls[1]!.init.headers['Content-Type']).toBeUndefined();
  });

  it('falls back to the conventional send URL when upload_url is absent', async () => {
    mockFetch(url => {
      if (url.endsWith('/file_uploads')) return ok({ id: 'fu_9' });
      return ok({ status: 'uploaded' });
    });
    await uploadFileToNotion('key', { filename: 'x.bin', bytes: Buffer.from('x'), contentType: 'application/octet-stream' });
    expect(calls[1]!.url).toContain('/file_uploads/fu_9/send');
  });

  it('throws when the create step fails', async () => {
    mockFetch(url => url.endsWith('/file_uploads') ? fail(400, { message: 'bad request' }) : ok({}));
    await expect(uploadFileToNotion('key', { filename: 'a.png', bytes: Buffer.from('x'), contentType: 'image/png' }))
      .rejects.toThrow(/bad request/);
  });

  it('throws when the send step fails', async () => {
    mockFetch(url => url.endsWith('/send') ? fail(500, { message: 'send failed' }) : ok({ id: 'fu_1', upload_url: 'https://api.notion.com/v1/file_uploads/fu_1/send' }));
    await expect(uploadFileToNotion('key', { filename: 'a.png', bytes: Buffer.from('x'), contentType: 'image/png' }))
      .rejects.toThrow(/send failed/);
  });
});

describe('appendArtifactBlock', () => {
  it('appends an image block referencing the file_upload, with caption', async () => {
    mockFetch(() => ok({ results: [] }));
    await appendArtifactBlock('key', 'page1', { fileUploadId: 'fu_1', kind: 'image', caption: 'Hero on white' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/blocks/page1/children');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.init.headers['Notion-Version']).toBe(NOTION_UPLOAD_VERSION);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.children[0]).toMatchObject({
      object: 'block', type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'fu_1' } },
    });
    expect(body.children[0].image.caption[0].text.content).toBe('Hero on white');
  });

  it('appends a file block for non-image artifacts', async () => {
    mockFetch(() => ok({ results: [] }));
    await appendArtifactBlock('key', 'p', { fileUploadId: 'fu_2', kind: 'file' });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.children[0]).toMatchObject({ type: 'file', file: { type: 'file_upload', file_upload: { id: 'fu_2' } } });
    expect(body.children[0].file.caption).toEqual([]);
  });

  it('throws when Notion rejects the append', async () => {
    mockFetch(() => fail(400, { message: 'validation error' }));
    await expect(appendArtifactBlock('key', 'p', { fileUploadId: 'fu_1', kind: 'image' }))
      .rejects.toThrow(/validation error/);
  });
});
