import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ERROR_CODES, type ErrorCode, NON_RETRYABLE, RETRYABLE } from '../src/errors';

/**
 * The error vocabulary's own invariant (`docs/0-API.md` §7, `docs/0-TESTING.md` §2).
 *
 * The table in `src/errors.ts` is a promise: every code in it is an answer a client may receive, and the API document
 * tells the client what to do about each one. Two codes were in that table with nothing anywhere able to raise them —
 * `PASSWORD_REQUIRED`, whose documented action is "prompt", and `FIELD_TYPE_MISMATCH`, whose refusal the shipped
 * `fill-form` reports as a warning instead — and both were found by hand, in a pass that happened to be reading this
 * category. That is exactly the kind of finding a check should make, so here it is as a check: a code the product
 * cannot produce is a code the product must not publish, and a table this test can no longer drift from.
 *
 * The corpus is the *product*: the contract packages, the API and the workers. `scripts/` and `e2e/` are deliberately
 * outside it, and that exclusion is the load-bearing decision rather than tidiness — the golden suite names an expected
 * error on almost every case, so a harness that could satisfy this test would let a dead code be resurrected by
 * writing `expectError: 'SOMETHING_NEW'` into a case, which is the opposite of the guarantee being bought here.
 *
 * Comments are stripped first, because this repository's comments are full of code names: `WORKER_LOST` is named in a
 * sentence in `cleanup-service.ts` above the line that raises it, and a scan that counted prose would pass a code that
 * only prose mentions. What is scanned is the code.
 */

const REPO_ROOT = findRepoRoot();
const SCANNED_ROOTS = ['packages', 'apps', 'workers'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'test', '__tests__']);

function findRepoRoot(): string {
  let current = import.meta.dir;
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(current, 'package.json');
    try {
      if (readFileSync(manifest, 'utf8').includes('"workspaces"')) return current;
    } catch {
      // Not this directory; keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not find the repository root (a package.json with \`workspaces\`) from ${import.meta.dir}`);
}

/** Every `.ts`/`.tsx` file under a root, minus tests — the vocabulary's own file is excluded by name below. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    if (!statSync(path).isFile()) continue;
    found.push(path);
  }
  return found;
}

/**
 * Remove comments, keeping line structure so a failure's file can still be found by eye.
 *
 * Block comments go wholesale. Line comments are only removed when the **whole line** is one — leading whitespace, then
 * the two comment slashes — which is how every comment in this repository is written, and which cannot eat the slashes
 * inside a URL or a path: a truncation there would hide a real raise site and report a live code as dead.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function corpus(): { text: string; files: number } {
  // `src/errors.ts` is the table itself; it is excluded or every code would trivially satisfy the scan.
  const table = join(REPO_ROOT, 'packages/contracts/src/errors.ts');
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root))).filter((file) => file !== table);
  return { text: files.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n'), files: files.length };
}

test('every error code in the vocabulary is raised somewhere in the product', () => {
  const { text, files } = corpus();
  // A scan over an empty corpus would report every code as dead, which reads as a product-wide catastrophe rather than
  // the path bug it would be.
  expect(files).toBeGreaterThan(100);
  const unreachable = (Object.keys(ERROR_CODES) as ErrorCode[]).filter((code) => !text.includes(`'${code}'`));
  expect(unreachable).toEqual([]);
});

test('the retry sets name codes that exist, and never the same one twice', () => {
  // The same table read the other way. `RETRYABLE`/`NON_RETRYABLE` are deliberately *partial* — they carry the codes
  // where retrying is a real question, not an exhaustive partition — so what is asserted is only what must hold for
  // them to mean anything: a name in either set that is not in the table is a typo that would never match anything,
  // and a code in both is a contradiction the retry policy would resolve by whichever set it read first.
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];
  const unknown = [...RETRYABLE, ...NON_RETRYABLE].filter((code) => !codes.includes(code));
  expect(unknown).toEqual([]);
  const both = codes.filter((code) => RETRYABLE.has(code) && NON_RETRYABLE.has(code));
  expect(both).toEqual([]);
});
