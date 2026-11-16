import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { AppError } from '@pdftools/errors';

/**
 * Streaming `multipart/form-data` reader.
 *
 * `request.formData()` buffers the whole body before the handler sees a byte, which breaks the rule that large
 * uploads are streamed (spec §30, §48 #11). This reader consumes the request stream, and the moment it finds the
 * `file` part it pipes bytes straight to disk while hashing them — memory stays flat regardless of file size.
 *
 * Scope: exactly what `POST /api/v1/files` needs. One file part, plus optional small text fields that appear
 * *before* the file, which is the order browsers send them in. Anything else is a `VALIDATION_ERROR` rather than
 * a silent truncation.
 */

export interface StreamedUpload {
  /** Text fields that arrived before the file part. */
  fields: Record<string, string>;
  /** Path the bytes were written to. */
  path: string;
  originalName: string;
  declaredType: string;
  sizeBytes: number;
  checksumSha256: string;
}

const CRLF = Buffer.from('\r\n');
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');

interface PartHeader {
  name: string | null;
  filename: string | null;
  contentType: string;
}

function parsePartHeaders(raw: Buffer): PartHeader {
  const text = raw.toString('utf8');
  const result: PartHeader = { name: null, filename: null, contentType: 'application/octet-stream' };
  for (const line of text.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'content-disposition') {
      const nameMatch = /name="([^"]*)"/i.exec(value);
      const fileMatch = /filename="([^"]*)"/i.exec(value);
      result.name = nameMatch?.[1] ?? null;
      result.filename = fileMatch?.[1] ?? null;
    } else if (key === 'content-type') {
      result.contentType = value;
    }
  }
  return result;
}

export function boundaryFromContentType(contentType: string | null): string {
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) {
    throw new AppError('INVALID_FILE', 'Uploads must use multipart/form-data.');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new AppError('INVALID_FILE', 'The multipart body has no boundary.');
  return boundary.trim();
}

export async function streamMultipartFile(
  request: Request,
  options: { destPath: string; maxBytes: number; fieldName?: string },
): Promise<StreamedUpload> {
  const boundary = boundaryFromContentType(request.headers.get('content-type'));
  const bodyEnd = Buffer.from(`\r\n--${boundary}`);
  const fieldName = options.fieldName ?? 'file';

  if (!request.body) throw new AppError('INVALID_FILE', 'The request has no body.');

  const reader = request.body.getReader();
  const hash = createHash('sha256');
  const fields: Record<string, string> = {};

  let buffer = Buffer.alloc(0);
  let bytesRead = 0;
  let state: 'preamble' | 'headers' | 'body' | 'done' = 'preamble';
  let currentPart: PartHeader | null = null;
  /** Bytes of the current text field, kept until its delimiter so a value split across chunks is not truncated. */
  let fieldChunks: Buffer[] = [];
  let sink: ReturnType<typeof createWriteStream> | null = null;
  let sinkPath: string | null = null;
  let sizeBytes = 0;
  let finished = false;

  const upload: StreamedUpload = {
    fields,
    path: '',
    originalName: '',
    declaredType: 'application/octet-stream',
    sizeBytes: 0,
    checksumSha256: '',
  };

  /**
   * `reader.cancel()` is fired and forgotten, never awaited. A body stream the client is still uploading into does
   * not reliably settle its cancel, and awaiting it turns "this file is too large" into a request that never
   * answers — a connection stuck holding a worker slot, which is worse than a socket that closes late. The partial
   * file on disk is what actually needed cleaning up, and that is awaited.
   */
  const cancelStream = (): void => {
    void reader.cancel().catch(() => {});
  };

  const fail = async (error: AppError): Promise<never> => {
    sink?.destroy();
    sink = null;
    if (sinkPath) await unlink(sinkPath).catch(() => {});
    cancelStream();
    throw error;
  };

  const writeBodyChunk = async (chunk: Buffer) => {
    if (!sink) {
      // Not the file part: it is a text field, and its bytes are collected rather than dropped.
      if (currentPart?.name) fieldChunks.push(chunk);
      return;
    }
    sizeBytes += chunk.length;
    if (sizeBytes > options.maxBytes) {
      await fail(new AppError('FILE_TOO_LARGE', undefined, { limitMb: Math.round(options.maxBytes / 1024 / 1024) }));
    }
    hash.update(chunk);
    if (!sink.write(chunk)) await once(sink, 'drain');
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, Buffer.from(value)]);

      let progressed = true;
      while (progressed) {
        progressed = false;

        if (state === 'preamble' || state === 'headers') {
          const headEnd = buffer.indexOf(HEADER_SEPARATOR);
          if (headEnd < 0) {
            // Guard against a header block that never terminates.
            if (buffer.length > 64 * 1024) {
              await fail(new AppError('INVALID_FILE', 'The multipart headers are too large.'));
            }
            continue;
          }
          const headBlock = buffer.subarray(0, headEnd);
          buffer = buffer.subarray(headEnd + HEADER_SEPARATOR.length);

          if (state === 'preamble') {
            // The opening block is the delimiter line followed by the first part's headers, and the separator just
            // consumed is what terminated *those* headers. Parsing them here — rather than looping back to
            // `headers`, which would wait for a terminator that has already been consumed — is the whole trick:
            // re-entering would silently scan past the separator and find the *next* part's, so every upload
            // would look like a body with no part in it.
            const lineEnd = headBlock.indexOf(CRLF);
            if (lineEnd < 0) {
              await fail(new AppError('INVALID_FILE', 'The multipart preamble is malformed.'));
            }
            currentPart = parsePartHeaders(headBlock.subarray(lineEnd + CRLF.length));
          } else {
            currentPart = parsePartHeaders(headBlock);
          }

          fieldChunks = [];
          // The assignment happens here, in the statement flow, rather than inside a helper: TypeScript does not
          // watch a closure's assignments, so `sink` would be narrowed to `null` (never) at every later read.
          if (currentPart.filename != null || currentPart.name === fieldName) {
            sink = createWriteStream(options.destPath, { flags: 'wx' });
            sinkPath = options.destPath;
            upload.originalName = currentPart.filename ?? fieldName;
            upload.declaredType = currentPart.contentType;
          }

          state = 'body';
          progressed = true;
          continue;
        }

        if (state === 'body') {
          const endIdx = buffer.indexOf(bodyEnd);
          if (endIdx < 0) {
            // Keep a tail that could contain a partial delimiter, flush the rest.
            const keep = bodyEnd.length + 4;
            if (buffer.length > keep) {
              const flush = buffer.subarray(0, buffer.length - keep);
              buffer = buffer.subarray(buffer.length - keep);
              await writeBodyChunk(flush);
              progressed = true;
            }
            continue;
          }

          const chunk = buffer.subarray(0, endIdx);
          buffer = buffer.subarray(endIdx + bodyEnd.length);
          progressed = true;

          if (sink) {
            await writeBodyChunk(chunk);
            sink.end();
            await once(sink, 'finish').catch(() => {});
            sink = null;
          } else if (currentPart?.name) {
            if (chunk.length > 0) fieldChunks.push(chunk);
            fields[currentPart.name] = Buffer.concat(fieldChunks).toString('utf8');
            fieldChunks = [];
          }

          // Terminal delimiter?
          if (buffer.subarray(0, 2).toString() === '--') {
            state = 'done';
            finished = true;
          } else {
            // Skip the CRLF that follows the delimiter and move to the next part's headers.
            if (buffer.subarray(0, 2).toString() === '\r\n') buffer = buffer.subarray(2);
            state = 'headers';
          }
        }
      }
    }
  } finally {
    if (sink) {
      sink.end();
      await once(sink, 'finish').catch(() => {});
    }
    cancelStream();
  }

  if (!sinkPath) {
    // `bodyBytes` is the diagnostic that matters when this happens in the wild: it separates "the client sent
    // nothing" (0) from "a proxy or framework consumed the stream before us" (0 with a declared content-length),
    // which are two very different incidents that produce the same useless message otherwise.
    throw new AppError('INVALID_FILE', `No "${fieldName}" part was found in the upload.`, {
      bodyBytes: bytesRead,
      declaredLength: request.headers.get('content-length') ?? undefined,
      boundaryLength: boundary.length,
      fields: Object.keys(fields),
    });
  }
  if (sizeBytes === 0) {
    await unlink(sinkPath).catch(() => {});
    throw new AppError('INVALID_FILE', 'The uploaded file is empty.');
  }

  upload.path = sinkPath;
  upload.sizeBytes = sizeBytes;
  upload.checksumSha256 = hash.digest('hex');
  return upload;
}
