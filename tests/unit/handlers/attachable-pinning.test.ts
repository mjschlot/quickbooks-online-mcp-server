import { jest, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { mockQuickbooksClient, mockQuickbooksClientClass } from '../../mocks/quickbooks.mock';

const mockLookup = jest.fn();
jest.unstable_mockModule('dns/promises', () => ({
  lookup: mockLookup,
}));

jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
  QuickbooksClient: mockQuickbooksClientClass,
}));

const mockHttpsRequest = jest.fn();
jest.unstable_mockModule('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest,
}));

// The request is a real Writable so the file part can be piped into it; the
// response fires only after req.end(), like a real server.
function mockStreamingUploadResponse(statusCode: number, responseBody: unknown) {
  const captured: { body: Buffer } = { body: Buffer.alloc(0) };
  (mockHttpsRequest as any).mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
    const chunks: Buffer[] = [];
    const req = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    req.on('finish', () => {
      captured.body = Buffer.concat(chunks);
      const payload = JSON.stringify(responseBody);
      callback({
        statusCode,
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'data') handler(Buffer.from(payload));
          if (event === 'end') handler();
        },
      });
    });
    return req;
  });
  return captured;
}

const { pinFetchedFile, pinLocalFile } = await import('../../../src/helpers/attachable-file-source');
const { createQuickbooksAttachable, pinAttachableSource } = await import(
  '../../../src/handlers/create-quickbooks-attachable.handler'
);
const { CreateAttachableTool } = await import('../../../src/tools/create-attachable.tool');
const { createApprovalHandler } = await import('../../../src/approval/approval-handler');

const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;
const callSignal = new AbortController().signal;
const realFetch = globalThis.fetch;
const mockFetch = jest.fn();
const savedBaseDir = process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
let baseDir: string;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

async function pinDirs(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('qbo-attach-pin-'));
}

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbo-pin-base-'));
  process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = baseDir;
});

afterAll(async () => {
  if (savedBaseDir === undefined) delete process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR;
  else process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = savedBaseDir;
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockLookup.mockReset();
  mockFetch.mockReset();
  mockHttpsRequest.mockReset();
  (mockLookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('pinAttachableSource with file_path', () => {
  it('copies the bytes into a private temp file and reports their size and SHA-256', async () => {
    const bytes = Buffer.from('%PDF-1.7 original receipt');
    const original = path.join(baseDir, 'receipt.pdf');
    await fs.writeFile(original, bytes);

    const pinned = required(await pinAttachableSource({ file_name: 'receipt.pdf', file_path: original }, callSignal));

    expect(pinned.facts).toEqual({ source: 'file_path', bytes: bytes.length, sha256: sha256(bytes) });
    expect(pinned.source).toMatchObject({ size: bytes.length, sha256: sha256(bytes), contentTypeHeader: null });
    expect(pinned.source.path.startsWith(os.tmpdir())).toBe(true);
    expect(pinned.source.path).not.toBe(original);
    expect(await fs.readFile(pinned.source.path)).toEqual(bytes);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(pinned.source.path))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(pinned.source.path)).mode & 0o777).toBe(0o600);
    }

    await pinned.dispose();
    expect(await exists(path.dirname(pinned.source.path))).toBe(false);
    expect(await exists(original)).toBe(true);
  });

  it('uploads the pinned bytes even when the original file changes after approval', async () => {
    const approvedBytes = Buffer.from('%PDF-1.7 approved');
    const replacedBytes = Buffer.from('%PDF-1.7 replaced after approval');
    const original = path.join(baseDir, 'changing.pdf');
    await fs.writeFile(original, approvedBytes);
    const params = { file_name: 'changing.pdf', file_path: original };

    const prepared = await required(CreateAttachableTool.prepareApproval)({ params }, callSignal);
    expect(prepared.facts).toMatchObject({ sha256: sha256(approvedBytes) });
    await fs.writeFile(original, replacedBytes);
    const captured = mockStreamingUploadResponse(200, { AttachableResponse: [{ Attachable: { Id: '9' } }] });

    const result = await prepared.handler({ params }, extra);
    await prepared.dispose();

    expect(result.content[0]).toEqual({ type: 'text', text: 'Attachable created:' });
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(captured.body.includes(approvedBytes)).toBe(true);
    expect(captured.body.includes(replacedBytes)).toBe(false);
    expect(captured.body.toString('utf8', 0, 600)).toContain('Content-Type: application/pdf');
  });

  it('refuses to upload when the pinned copy no longer matches the approved hash', async () => {
    const original = path.join(baseDir, 'tamper.pdf');
    await fs.writeFile(original, Buffer.from('%PDF-1.7 approved'));
    const data = { file_name: 'tamper.pdf', file_path: original };
    const pinned = required(await pinAttachableSource(data, callSignal));
    await fs.writeFile(pinned.source.path, Buffer.from('%PDF-1.7 tampered'));

    const result = await createQuickbooksAttachable(data, pinned.source);
    await pinned.dispose();

    expect(result).toEqual({
      result: null,
      isError: true,
      error: 'Pinned file content changed after approval; nothing was uploaded.',
    });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('fails before approval for a path the allowlist rejects', async () => {
    const hidden = path.join(baseDir, '.hidden.pdf');
    await fs.writeFile(hidden, Buffer.from('%PDF'));
    const before = await pinDirs();

    await expect(
      required(CreateAttachableTool.prepareApproval)({ params: { file_name: 'x.pdf', file_path: hidden } }, callSignal)
    ).rejects.toThrow('file_path denied: dotfiles and dot-directories are not attachable');

    expect(await pinDirs()).toEqual(before);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('fails and removes the temp directory when fewer bytes than expected are read', async () => {
    const original = path.join(baseDir, 'short.pdf');
    await fs.writeFile(original, Buffer.alloc(10, 1));
    const before = await pinDirs();

    await expect(pinLocalFile({ path: original, size: 20 })).rejects.toThrow(
      'file_path changed while it was being read: read 10 of 20 expected bytes.'
    );
    expect(await pinDirs()).toEqual(before);
  });
});

describe('pinAttachableSource with file_url', () => {
  it('downloads before approval and uploads the downloaded file without fetching again', async () => {
    const bytes = Buffer.from('%PDF-1.7 downloaded');
    (mockFetch as any).mockResolvedValue(
      new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/pdf' } })
    );
    const data = { file_name: 'download', file_url: 'https://example.com/files/r.pdf' };

    const pinned = required(await pinAttachableSource(data, callSignal));
    expect(pinned.facts).toEqual({
      source: 'file_url',
      bytes: bytes.length,
      sha256: sha256(bytes),
      content_type_header: 'application/pdf',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const captured = mockStreamingUploadResponse(200, { ok: true });
    const result = await createQuickbooksAttachable(data, pinned.source);
    expect(result.isError).toBe(false);
    expect(captured.body.includes(bytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(await exists(pinned.source.path)).toBe(true);
    await pinned.dispose();
    expect(await exists(pinned.source.path)).toBe(false);
  });

  it('omits the content type fact when the response has no Content-Type header', async () => {
    (mockFetch as any).mockResolvedValue(new Response(new Uint8Array(Buffer.from('%PDF')), { status: 200 }));
    const pinned = required(
      await pinAttachableSource({ file_name: 'r.pdf', file_url: 'https://example.com/r' }, callSignal)
    );
    expect(pinned.facts).not.toHaveProperty('content_type_header');
    expect(pinned.source.contentTypeHeader).toBeNull();
    await pinned.dispose();
  });

  it('cleans up the download when it cannot be hashed', async () => {
    const cleanup = jest.fn(async () => undefined);
    await expect(
      pinFetchedFile({
        path: path.join(baseDir, 'missing-download.tmp'),
        size: 1,
        contentTypeHeader: null,
        cleanup,
      })
    ).rejects.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('create_attachable approval preparation without a single file reference', () => {
  it.each([
    ['base64 content', { file_name: 'a.txt', base64_content: Buffer.from('hi').toString('base64') }],
    ['metadata only', { file_name: 'a.txt' }],
    ['conflicting file_path and file_url', { file_name: 'a.pdf', file_path: '/x.pdf', file_url: 'https://example.com/a.pdf' }],
  ])('pins nothing for %s and uses the unpinned handler', async (_label, params) => {
    const before = await pinDirs();
    const prepared = await required(CreateAttachableTool.prepareApproval)({ params }, callSignal);
    expect(prepared.facts).toEqual({});
    expect(prepared.handler).toBe(CreateAttachableTool.handler);
    await expect(prepared.dispose()).resolves.toBeUndefined();
    expect(await pinDirs()).toEqual(before);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('create_attachable allow-mode handler', () => {
  it('returns handler errors as an Error text result', async () => {
    const result = await CreateAttachableTool.handler(
      { params: { file_name: 'a.pdf', file_path: '/x.pdf', file_url: 'https://example.com/a.pdf' } },
      extra
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Provide either file_url or file_path, not both.' }]);
  });

  it('still reads file_path when it runs, without pinning', async () => {
    const original = path.join(baseDir, 'allow.pdf');
    await fs.writeFile(original, Buffer.from('%PDF-1.7 first'));
    const current = Buffer.from('%PDF-1.7 current at execution');
    await fs.writeFile(original, current);
    const captured = mockStreamingUploadResponse(200, { ok: true });
    const before = await pinDirs();

    const result = await CreateAttachableTool.handler({ params: { file_name: 'allow.pdf', file_path: original } }, extra);

    expect(result.content[0]).toEqual({ type: 'text', text: 'Attachable created:' });
    expect(captured.body.includes(current)).toBe(true);
    expect(await pinDirs()).toEqual(before);
  });
});

describe('create_attachable approval when the tool call is canceled during the download', () => {
  it('denies as canceled, runs no handler, and removes the partial download', async () => {
    const controller = new AbortController();
    const downloads = async () =>
      (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(`qbo-attach-${process.pid}-`));
    const before = await downloads();
    let partialDownloads: string[] = [];
    (mockFetch as any).mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
          stream.enqueue(new Uint8Array(Buffer.from('%PDF-1.7 partial')));
        },
        async pull() {
          partialDownloads = await downloads();
          controller.abort();
          return new Promise<void>(() => undefined);
        },
      });
      return new Response(body, { status: 200 });
    });
    const elicitInput = jest.fn();
    const server = {
      server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput },
    } as unknown as Parameters<typeof createApprovalHandler>[0];
    const handler = createApprovalHandler(
      server,
      CreateAttachableTool as unknown as Parameters<typeof createApprovalHandler>[1],
      'WRITE',
      { timeoutMs: 300_000, auditLogPath: null },
      { realmId: async () => '9130' }
    );

    const result = await handler(
      { params: { file_name: 'r.pdf', file_url: 'https://example.com/r.pdf' } },
      { ...extra, signal: controller.signal, requestId: 1 }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('(canceled)') });
    expect(elicitInput).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(partialDownloads.length).toBe(before.length + 1);
    expect(await downloads()).toEqual(before);
  });
});
