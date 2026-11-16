import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import { largestInputBatch } from '@pdftools/contracts';
import { AppError } from '@pdftools/errors';
import { Elysia } from 'elysia';
import { ensureDir } from '../infrastructure/storage';
import { resolveIdentity } from '../plugins/session';
import { assertCreationAllowed } from '../services/access-policy';
import { appSwitches } from '../services/app-switches';
import { deleteFile, loadFile, storeUpload } from '../services/file-service';
import { assertRateLimit, limitsFor } from '../services/quota-service';
import { streamMultipartFile } from '../shared/multipart';

/**
 * `docs/0-API.md` §3.
 *
 * Uploads are streamed straight to disk by `streamMultipartFile`: the body is never held in memory, which is
 * what keeps a 1 GB Business upload from becoming a 1 GB allocation.
 */
export const filesModule = new Elysia({ prefix: '/api/v1/files', tags: ['files'] })
  .post(
    '/',
    async (ctx) => {
      // `request` and `set` are read off the context rather than destructured out of it: `resolveIdentity` needs
      // both, and taking them out of the handler's parameter is what made its `request` `undefined`.
      const { request, set } = ctx;
      const auth = await resolveIdentity(ctx);
      // Before the rate limit and before the body is read: a caller who may not upload must not be charged for
      // trying, and the refusal must not depend on how large the file was going to be. The assertion also narrows
      // `auth.identity` to a `WorkIdentity`, which is what makes `storeUpload` unreachable from a guest at compile
      // time rather than at review time (`services/access-policy.ts`).
      assertCreationAllowed(auth.identity, await appSwitches().resolve());
      const limits = await limitsFor(auth.identity);
      // Charged once per file, so the burst allowance is one maximal legal batch (`largestInputBatch()`): without it,
      // a 50-file merge — a request the registry accepts — could not be staged inside a minute, whatever the engine
      // then costs. Sustained uploads stay at half the general limit, which is what this limiter is for.
      await assertRateLimit(
        `upload:${auth.identity.ownerId}`,
        config.limits.rateLimitPerMinute / 2,
        largestInputBatch(),
      );

      const maxBytes = Math.min(limits.maxFileMb, config.limits.maxFileSizeMb) * 1024 * 1024;
      await ensureDir(config.storage.stagingDir);
      const tempPath = join(config.storage.stagingDir, `${randomUUID()}.upload`);

      // Typed rather than inferred-and-`any`: the reader's return shape is what the rest of this handler consumes,
      // and an implicit `any` here would let a rename inside the reader pass unnoticed.
      let streamed: Awaited<ReturnType<typeof streamMultipartFile>>;
      try {
        streamed = await streamMultipartFile(request, { destPath: tempPath, maxBytes });
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }

      const kind = streamed.fields.kind ?? 'input';
      if (kind !== 'input' && kind !== 'attachment') {
        await unlink(tempPath).catch(() => {});
        throw new AppError('VALIDATION_ERROR', 'kind must be "input" or "attachment".');
      }

      const stored = await storeUpload(auth.identity, {
        tempPath: streamed.path,
        originalName: streamed.originalName,
        declaredType: streamed.declaredType,
        sizeBytes: streamed.sizeBytes,
        checksumSha256: streamed.checksumSha256,
      });

      set.status = 201;
      return stored;
    },
    {
      // `parse: 'none'` is the whole reason this upload streams. Elysia's default parser set includes
      // `formdata`, and a parsed body is a *consumed* stream: the reader below would then get zero bytes and
      // report a missing part — which is exactly what it did until this was spelled out (`bodyBytes: 0` with a
      // `content-length` of 1355 was the giveaway). `none` makes the framework skip body handling for this route,
      // leaving the raw stream for `streamMultipartFile`. Narrowing the list instead (`['json','text']`) is not
      // the same thing: it still runs the parser pipeline and rejects the request as a bad body.
      parse: 'none',
      detail: {
        summary: 'Upload a file',
        description:
          'Streams one multipart file to staging, detects its type from magic bytes, and returns an id to reference in POST /jobs.',
      },
    },
  )
  .get('/:id', async ({ params, ...ctx }) => {
    const auth = await resolveIdentity(ctx);
    const file = await loadFile(params.id, auth.identity);
    return {
      id: file.id,
      name: file.name,
      detectedType: file.detectedType,
      sizeBytes: file.sizeBytes,
      pages: file.pages,
      encrypted: file.encrypted,
      checksumSha256: file.checksumSha256,
      createdAt: file.createdAt.toISOString(),
      expiresAt: file.expiresAt.toISOString(),
    };
  })
  .delete('/:id', async (ctx) => {
    const { params, set } = ctx;
    const auth = await resolveIdentity(ctx);
    await deleteFile(params.id, auth.identity);
    set.status = 204;
    return null;
  })
  .get('/:id/preview', async ({ params }) => {
    // Preview requires rendering, and rendering is a worker job. The API deliberately cannot spawn an engine
    // (`0-FOLDER-STRUCTURE.md` §2 boundary rule), so this is an honest 501 with the supported alternative
    // rather than a second, divergent rendering path inside the API.
    throw new AppError(
      'NOT_IMPLEMENTED',
      'Page previews are produced by the worker pools. Use PDF to images to render pages.',
      { fileId: params.id },
    );
  });
