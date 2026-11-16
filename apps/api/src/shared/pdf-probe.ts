/**
 * Cheap PDF inspection, done in-process because the API is not allowed to spawn an engine.
 *
 * What this can and cannot do, stated plainly:
 *
 * - **Encryption**: reliable. `/Encrypt` in the trailer is what every reader looks for.
 * - **Page count**: a best-effort scan of the raw bytes. It finds `/Type /Page` objects and `/Count n` in the
 *   page tree, which covers the overwhelming majority of files. A PDF whose page tree lives entirely inside an
 *   object stream, or whose page objects use unusual spacing, comes back as `null`.
 *
 * The two windows it scans — a header and a tail — are **disjoint**. Sharing a byte between them is not a rounding
 * detail: the fallback counts `/Type /Page` occurrences, so a file small enough to sit inside the header window was
 * scanned twice and reported twice its page count. A one-page form came back as two, which is a page count wrong in
 * the direction that matters (`docs/0-QUEUE-AND-JOBS.md` §3 step 5 re-checks it, but only for the plan limit).
 *
 * `null` is a legitimate answer here and the code that consumes it must treat it that way: the plan page limit is
 * enforced against a *known* count, and the worker re-checks the real count at claim time
 * (`docs/0-QUEUE-AND-JOBS.md` §3 step 5). Guessing a number would be worse than admitting we do not know it —
 * a wrong high guess rejects valid jobs, a wrong low guess lets oversized ones through.
 */

export interface PdfProbe {
  encrypted: boolean;
  pages: number | null;
  version: string | null;
}

export async function probePdf(path: string): Promise<PdfProbe> {
  const file = Bun.file(path);
  const size = file.size;
  // Page trees sit near the end of the file; the header is at the start. The tail is measured from the end of the
  // header rather than from the end of the file, so the two slices never overlap — see the note above.
  const headSize = Math.min(size, 4096);
  const tailSize = Math.min(size - headSize, 512 * 1024);
  const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  const tail = new Uint8Array(await file.slice(size - tailSize).arrayBuffer());

  const headText = Buffer.from(head).toString('latin1');
  const tailText = Buffer.from(tail).toString('latin1');

  const versionMatch = /%PDF-(\d\.\d)/.exec(headText);
  const encrypted = /\/Encrypt\b/.test(tailText) || /\/Encrypt\b/.test(headText);

  let pages: number | null = null;

  // `/Count` on the root page tree is the cheapest accurate signal when it is present and uncompressed.
  const counts = [...tailText.matchAll(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/g)]
    .map((m) => Number.parseInt(m[1] ?? '0', 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (counts.length > 0) {
    pages = Math.max(...counts);
  } else {
    // Fall back to counting page objects. `/Type/Page` must not match `/Type/Pages`.
    const pageObjects = tailText.match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
    const headObjects = headText.match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
    const total = pageObjects + headObjects;
    pages = total > 0 ? total : null;
  }

  if (encrypted) pages = null;

  return { encrypted, pages, version: versionMatch?.[1] ?? null };
}
