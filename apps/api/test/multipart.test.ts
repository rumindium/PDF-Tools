import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamMultipartFile } from '../src/shared/multipart';

/**
 * The upload reader is the one place where a silent bug costs a user their file: a parser that finds no part
 * returns 400, but a parser that finds the *wrong* part or truncates one returns a corrupt job and no error at
 * all. Both are covered here, with the real `FormData` a browser (and the E2E test) produces rather than a
 * hand-written body — the bug this file first caught was exactly a disagreement with Bun's encoder.
 */

const paths: string[] = [];

function dest(): string {
  const path = join(tmpdir(), `pdftools-test-${randomUUID()}.upload`);
  paths.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
});

async function stream(form: FormData, maxBytes = 10 * 1024 * 1024) {
  const request = new Request('http://localhost/api/v1/files', { method: 'POST', body: form });
  const path = dest();
  const upload = await streamMultipartFile(request, { destPath: path, maxBytes });
  return { upload, bytes: await readFile(path) };
}

describe('streamMultipartFile', () => {
  test('reads a small field that precedes the file, the order a browser sends them in', async () => {
    const body = new TextEncoder().encode('%PDF-1.7 first');
    const form = new FormData();
    form.append('kind', 'input');
    form.append('file', new File([body], 'one.pdf', { type: 'application/pdf' }));

    const { upload, bytes } = await stream(form);

    expect(upload.fields.kind).toBe('input');
    expect(upload.originalName).toBe('one.pdf');
    expect(upload.declaredType).toBe('application/pdf');
    expect(upload.sizeBytes).toBe(body.length);
    expect(bytes.equals(Buffer.from(body))).toBe(true);
    expect(upload.checksumSha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  test('reads a field that comes after the file part', async () => {
    const body = new TextEncoder().encode('%PDF-1.7 file-first');
    const form = new FormData();
    form.append('file', new File([body], 'first.pdf', { type: 'application/pdf' }));
    form.append('kind', 'attachment');

    const { upload, bytes } = await stream(form);

    expect(upload.fields.kind).toBe('attachment');
    expect(bytes.equals(Buffer.from(body))).toBe(true);
  });

  test('carries a multi-megabyte body across chunk boundaries intact', async () => {
    // Bigger than any single stream chunk, so the reader has to flush and keep a delimiter-length tail: an
    // off-by-one there truncates the file, which is the failure mode nothing else in this suite would notice.
    const body = Buffer.alloc(5 * 1024 * 1024 + 7);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const form = new FormData();
    form.append('kind', 'input');
    form.append('file', new File([body], 'big.pdf', { type: 'application/pdf' }));

    const { upload, bytes } = await stream(form, 20 * 1024 * 1024);

    expect(upload.sizeBytes).toBe(body.length);
    expect(bytes.length).toBe(body.length);
    expect(bytes.equals(body)).toBe(true);
  });

  test('refuses a body with no file part instead of returning an empty upload', async () => {
    const form = new FormData();
    form.append('kind', 'input');

    await expect(stream(form)).rejects.toThrow(/No "file" part was found/);
  });

  test('refuses an empty file part', async () => {
    const form = new FormData();
    form.append('file', new File([], 'empty.pdf', { type: 'application/pdf' }));

    await expect(stream(form)).rejects.toThrow(/empty/);
  });

  test('enforces the byte limit while streaming rather than after buffering', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(4096)], 'over.pdf', { type: 'application/pdf' }));

    // The code is the contract; the message is copy. It must also *return* — an over-limit upload that never
    // answers holds a connection open, which is why this lives next to the parser rather than in the route.
    const error = await stream(form, 1024).catch((caught: { code?: string }) => caught);
    expect(error.code).toBe('FILE_TOO_LARGE');
  });
});
