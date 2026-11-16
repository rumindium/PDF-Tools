#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STACK_GAP_EXIT_CODE, requireAnonymousUse, stackGapReason } from '../../e2e/lib/stack-gap';

/**
 * The falsification stage (`docs/0-CICD.md` §3.2): every check the suite trusts has to be able to fail.
 *
 * A green run says the product behaves. It does not say the check *looks* at the behaviour, and this project's worst
 * defects were found by breaking a claim on purpose and reading what happened: `n-up` keeping every page object it had
 * removed (defect 83), and the command-line guard firing on a value registered inside a live worker. Both were done by
 * hand — a `sed` inside a running container, one case run, a failure read — and that technique is worth more than the
 * cases it proved. As a habit it is fragile: it depends on someone remembering, on the `sed` being retyped correctly,
 * and on the container being recreated afterwards. This script is the habit.
 *
 * It is deliberately not part of `test:golden`. Golden answers "does the product work", and its numbers are the
 * evidence for that. This answers "would we know if it stopped working", by breaking one invariant at a time — and its
 * verdicts are inverted: a claim **passes when the case fails**, with the failure the invariant owes.
 *
 * The last three claims each guard an **absence** whose assertion the harness only makes when it is asked — text that
 * must be gone, a signature dictionary that must not be there, a warning that must be raised. That is the family a case
 * can pass by never checking the thing it names, and therefore the family this stage is worth most for; each of the
 * three names the flag that carries the assertion (`extraArgs`).
 *
 * Three properties make those verdicts worth having:
 *
 *   1. the patch is applied to the checkout's own bytes, and the target is asserted to be there first, so a claim whose
 *      invariant moved or disappeared fails loudly instead of quietly testing nothing;
 *   2. the patched container is **recreated**, in a `finally`, before the next claim runs — so no claim can be
 *      contaminated by the previous one, and a crash cannot leave a broken image serving the dev stack;
 *   3. a regression that writes a password into a durable store is cleaned up in the same `finally`, because the honest
 *      version of that experiment is the one that scrubs what it put there (`bun run secrets:audit -- --scrub`).
 *
 * A fourth family of claim has no checkout file at all. The **served asset** claims patch the built bundle inside the
 * `web` container — the stylesheet nginx serves and the chunks it hands out — which is the only way to falsify a claim
 * whose correction lives in CSS or in built JS: `Dockerfile.web` is a two-stage build whose runtime layer holds nginx
 * and the bundle, so there is nothing in the checkout to edit that the browser would read (`'checkout'` rebuilds the
 * image instead, which is the slow road), and these are exactly the claims that were falsified by hand with a `sed`
 * inside the running container for four passes. Their properties are inverted where it matters: **no rebuild and no
 * restart**, so a claim costs seconds instead of a build; the bytes are read out of the container before the patch and
 * written back in the `finally`, with the digest compared rather than assumed; and a patch has to **remove its own
 * target**, because a leftover patch cannot be told from an unpatched asset by looking at the asset — only by looking
 * for the line it replaced.
 *
 * Their patterns are written as regular expressions rather than as source lines, and that is not a convenience: the
 * bytes under test are minified, where an identifier is one or two letters assigned by the bundler and shifts whenever
 * anything in the chunk is edited. A claim that named `Me=V=>Math.min(O,V)` would go stale on an edit somewhere else in
 * the same chunk; a claim that names the *shape* — a two-argument `Math.min` whose second argument is its own parameter
 * — keeps meaning the same thing. `$1` references in `to` work the way `String.replace` does, so the matched names can be
 * put back.
 *
 *   bun run test:falsify                      every claim (needs the dev stack up)
 *   bun run test:falsify -- --only printed-surface
 *   bun run test:falsify -- --only panel-cap-shortens,panel-cap-scrolls
 *   bun run test:falsify -- --needs-browser   the served-bundle family (needs `web` up and a browser installed)
 *   bun run test:falsify -- --without-browser the rest — what the `falsify` job runs, whose stack has neither
 *   bun run test:falsify -- --only strict-edge-scope,strict-gate-asks-both-questions
 *   bun run test:falsify -- --base http://localhost:8090
 *
 * `--only` takes a comma-separated list, which exists for the strict group: those claims change the **stack's position**
 * (`position: 'strict'`), and the group is entered once and left once per invocation — so running them together is one
 * profile switch instead of five, while every other claim stays runnable one at a time.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'generated');
const ARTIFACT_DIR = join(REPO_ROOT, 'e2e', 'artifacts');
const ARTIFACT = join(ARTIFACT_DIR, 'falsify.json');

interface ToolCase {
  tool: string;
  files: string[];
  options?: Record<string, unknown>;
  plan?: string;
  /**
   * Harness flags the claim depends on, spelled the way `test:golden` spells them.
   *
   * A claim about an *absence* has to name the flag that asserts it — `--expect-no-signature-dictionary`,
   * `--expect-absent-text`, `--expect-warning` — because the harness only makes that assertion when asked. Running the
   * case without the flag would run it against a weaker check than the one the claim is about, and the verdict would
   * be a statement about the wrong thing.
   */
  extraArgs?: string[];
}

/**
 * A case whose subject is a **position the stack has to be in**, not a tool.
 *
 * Strict mode is the reason this exists. Its claim cannot be expressed as a tool case: on the ordinary stack the guard
 * it falsifies is not even exercised (anonymous use is on, so every route is open by policy), and the checks that can
 * see it are the stages that put the stack in the position — `test:tenant-first`'s strict leg and the browser case
 * that runs under `playwright.strict.config.ts`. Running a tool case here would be a claim about a check that never
 * looked at the regression, which is the failure mode this whole script exists to prevent.
 */
interface StageCase {
  stage: 'tenant-first' | 'strict-gate';
  extraArgs?: string[];
}

/**
 * A case that is a **browser** case: one file in `e2e/browser`, one test inside it.
 *
 * Selected by `--grep` rather than by running the file, so a claim pays for the test that owns its assertion instead of
 * for the whole file, and so the claim can name which case it measured. The runner gets an explicit `--reporter=line`,
 * which is not cosmetic: this repository's config writes the stage's own artifact (`e2e/artifacts/browser.json`), and a
 * one-test run under that config would overwrite an eleven-file stage's report with a single case.
 */
interface BrowserCase {
  browser: { file: string; grep: string; extraArgs?: string[] };
}

type CaseSpec = ToolCase | StageCase | BrowserCase;

interface Claim {
  id: string;
  /** What the product promises — the sentence a green check is supposed to be evidence for. */
  invariant: string;
  /** The regression injected into the container, in one line, for the reader of a failed run. */
  regression: string;
  /** Container to patch, and the file inside it (a path relative to the repository root, mounted at `<root>/<path>`). */
  service: string;
  /**
   * The file to patch, relative to the repository root.
   *
   * Absent for a `'served-asset'` claim, whose subject is not a file in the checkout at all: those name `asset` and get
   * the resolved path — hashed name and all — back out of the container.
   */
  path?: string;
  /**
   * Must appear in the copy being patched, and is replaced by `to`.
   *
   * A pattern where the copy is minified (see the header): a regular expression still makes "the line is gone" a loud
   * stale-claim error, while a literal minified identifier would make every claim stale the day the bundler renamed it.
   */
  from: string | RegExp;
  to: string;
  /** What the case has to print when the invariant is doing its job. */
  expect: RegExp;
  /** The case that must catch the regression. Kept minimal: it is the check under test that owes the failure. */
  case: CaseSpec;
  /** The regression leaves a password in the database, so the store is scrubbed before and after. */
  dirties?: boolean;
  /**
   * The stack position this claim's subject lives in; absent means the ordinary dev stack.
   *
   * `'strict'` means the platform answers that this app publishes **nothing**, so the caller the case drives is refused
   * the whole product. The stage provisions that position itself — the same overlay the tenant-first runbook uses, with
   * `PLATFORM_STUB_STRICT_MODE=true` — and asserts it took effect before the claim runs, because a claim measured on a
   * stack that is not in the position it names is a claim about nothing. The position is entered once for the group and
   * left in the `finally`, so a claim can never be measured against the previous one's stack.
   */
  position?: 'strict';
  /**
   * How the regression is injected.
   *
   * `'container'` (the default) writes the file into the running container and restarts it, which is how every claim
   * about the API and the workers has always worked: those images carry their sources and run them.
   *
   * `'checkout'` patches the file **on the host** and rebuilds the image, and it is not a preference — `Dockerfile.web`
   * is a two-stage build whose runtime layer holds only nginx and the built `dist`, so a file written into the `web`
   * container is a file nothing reads. A claim about the bundle has to change the checkout and let the build do its
   * work; the restore writes the original bytes back and rebuilds again, so the image the stack is left on is the one
   * the checkout describes.
   *
   * `'served-asset'` patches the **built bundle inside the container** — the fastest road there is, and the one this
   * stage's browser claims take: nginx serves those bytes straight off its own filesystem, so the patch is live on the
   * next request with no build and no restart, and the restore is the bytes read before the patch plus the recreation
   * the `finally` does anyway. The image remains the restore point, and the digest of the written-back asset is
   * compared against the bytes this run read, so a restore that half-happened is a verdict of its own.
   */
  mutate?: 'container' | 'checkout' | 'served-asset';
  /**
   * The assets a `'served-asset'` claim may live in, inside the container, with `*` standing for the content hash the
   * build put in the name (`/usr/share/nginx/html/assets/index-*.js`).
   *
   * A glob rather than a name, because the hash changes with every build and a claim pinned to one would be a claim
   * about a file that no longer exists — and because the bundler decides how many chunks there are and what goes in
   * each: `index-*.js` is two files in the current build. What names the file is therefore the **patch target**, not the
   * name: the glob's files are read, and exactly one of them has to contain the line. Zero is a claim whose invariant
   * moved (or moved into another chunk) and two is a claim that cannot say what it broke — both findings about the
   * claim, and both loud.
   */
  asset?: string;
  /**    * This claim is only falsifiable for a visitor who holds a session the installation refuses.
   *
   * The distinction matters because a *guest* is caught by the creation gate already, so the same case run without a
   * session passes with the regression injected — and that reads as "this check is not load-bearing" when the truth is
   * "this run had nobody to measure". `enterStrictPosition` mints the session before the position changes: from the dev
   * stack when it serves visitors, and otherwise through the stub, which is the authority for the position anyway —
   * so an app row with strict mode on no longer makes the visitor impossible to find. Only a stack that refuses
   * visitors in *both* places leaves this claim reporting itself rather than passing.
   */
  needsAnonymousSession?: boolean;
  /**
   * This claim needs a **browser** and the container that serves the bundle it reads.
   *
   * The one need that splits the stage across jobs rather than across invocations, and it is a need of the *case*, not a
   * preference: a served-asset claim patches the bundle nginx hands out, so it is measurable only where a `web`
   * container is up and a browser is installed — the assumptions the `browser` job already makes and the `falsify` job
   * deliberately does not (it starts no `web` and installs no browser). Declared here so both jobs can name the half
   * they can run (`--needs-browser` / `--without-browser`) instead of listing ids, which would let a sixth claim of
   * this family be silently skipped by the job that cannot measure it.
   */
  needsBrowser?: boolean;
}

/**
 * The claims, each one a claim the suite already makes. They are ordered by container, so the two-light-worker claims
 * run together, then the API's, then the heavy worker's: every claim recreates its container afterwards, and grouping
 * them is what keeps that cost down without letting one claim be measured against another's patch. The dirty claim is
 * last within the API group, after the clean one that shares the `encrypt` tool.
 */
const CLAIMS: Claim[] = [
  {
    id: 'spawn-guard',
    invariant: 'a password is never passed to an engine as a command-line argument',
    regression: "register a value that appears in *every* engine command line ('/work/') as a guarded secret",
    service: 'worker-light',
    path: 'workers/shared/src/runtime.ts',
    from: 'registerJobSecrets(jobId, Object.values(extractSecrets(def, queuedOptions)));',
    to: "registerJobSecrets(jobId, [...Object.values(extractSecrets(def, queuedOptions)), '/work/']);",
    expect: /SECRET_IN_ARGV/,
    case: {
      tool: 'pdf-to-images',
      files: ['pdf-to-images-two.pdf'],
      options: { format: 'png', dpi: 72 },
    },
  },
  {
    id: 'structural-invariant',
    invariant: 'the output holds no page object its page tree does not name',
    regression: 'stop deleting the `/AcroForm` whose fields still name the pages `n-up` removed',
    service: 'worker-light',
    path: 'workers/light/src/handlers/n-up.ts',
    from: '    del pdf.Root.AcroForm',
    to: '    pass',
    // The failure names both counts, because "the tree and the bytes disagree" is the whole assertion: one reader
    // saying two pages while another says three is the defect's shape (defect 83).
    expect: /where a byte scan counts/,
    case: {
      tool: 'n-up',
      files: ['redact-signed-a4.pdf'],
      options: { perSheet: 2, pageSize: 'a4', orientation: 'portrait' },
    },
  },
  {
    id: 'part-page-labels',
    invariant: 'each output part says which page of the document it is',
    regression: 'label every part with its position in the job instead of the page it came from',
    service: 'worker-light',
    path: 'workers/light/src/handlers/pdf-to-images.ts',
    from: '    outputs.push({ name: `${stem}.${ext}`, mime, pages: [pageList[index]!] });',
    to: '    outputs.push({ name: `${stem}.${ext}`, mime, pages: [index + 1] });',
    // The failure has to name the label, not the count: patching the *label* leaves one part for one page, so a claim
    // that expected "the wrong number of parts" would be a statement about an assertion that never ran.
    expect: /declares pages/,
    case: {
      tool: 'pdf-to-images',
      files: ['pages-six-a4.pdf'],
      options: { format: 'png', dpi: 72, pages: ['3'] },
      extraArgs: ['--expect-parts', '1', '--expect-part-pages', '0:3'],
    },
  },
  {
    // `merge` is the tool whose output is assembled by a *second* engine after qpdf has written it, so the two things
    // the decoration step promises — an outline rebuilt from the sources and the first input's metadata — are the two
    // claims a plain page-count check cannot see. Both are asserted in `e2e/merge.e2e.ts` (file-named parents,
    // nesting, remapped destinations, `/Info` title, XMP packet) and both are falsified here against the same file,
    // because a claim the sabotage stage cannot break is a claim nobody has proved the suite looks at.
    id: 'merge-outline-rebuilt',
    invariant: 'a merge rebuilds each input’s bookmarks, nested under an entry named after the file it came from',
    regression: 'stop rebuilding the outline, so the assembled document ships with the outline qpdf left — none',
    service: 'worker-light',
    path: 'packages/engines/src/outlines.ts',
    from: '    if mode != "none":',
    to: '    if False:  # falsify: no source outline is ever lifted into the merged document',
    // The failure has to name the missing title: with the outline gone the page count, the page text and the page
    // boxes are all still correct, so only the bytes assertion can see it.
    expect: /is missing from the output/,
    case: {
      tool: 'merge',
      files: ['bookmark-toc.pdf', 'bookmark-annex-a4.pdf'],
      options: { bookmarks: 'keep' },
      // Byte searches, not text: a bookmark title is not page content, so `pdftotext` cannot see it, and the parent
      // entry's name is the whole of the "one entry per input, named after the file" claim.
      extraArgs: ['--expect-bytes', 'bookmark-annex-a4.pdf'],
    },
  },
  {
    id: 'merge-metadata-carried',
    invariant: 'a merge keeps the first input’s document metadata',
    regression: 'stop copying the first input’s `/Info` values onto the merged document',
    service: 'worker-light',
    path: 'packages/engines/src/outlines.ts',
    from: '    for key, value in first.docinfo.items():',
    // No backticks in the injected line: it lands inside the handler's Python source, which lives in a TypeScript
    // template literal, and one there terminates the literal — the container boots with a syntax error instead of the
    // regression. Written out because that failure reads as "the claim is broken", which it was, in the worst way.
    to: '    for key, value in []:  # falsify: the source Info dict is not carried onto the output',
    expect: /is missing from the output/,
    case: {
      tool: 'merge',
      files: ['bookmark-toc.pdf', 'bookmark-annex-a4.pdf'],
      options: { bookmarks: 'keep' },
      // The fixture's own `/Info` title, which only the first input carries — the second fixture has none, so this
      // string proves *which* input's metadata was copied and not merely that some metadata exists.
      extraArgs: ['--expect-bytes', 'Bookmark fixture A title'],
    },
  },
  {
    // `split`'s half of the same claim, one part at a time: a part is assembled by `qpdf --empty --pages`, so it is a
    // **new** document whose `/Outlines` and `/Info` are absent unless the handler puts them back (defect 125). The
    // title asserted is the *nested* one on purpose — a decorator that lifted only top-level entries passes a case
    // that asks for a parent, and every page count, page label and byte search still passes either way.
    id: 'split-part-outline-lifted',
    invariant: 'a split part carries the source’s bookmarks for the pages it holds, nested as they were',
    regression: 'write each part without lifting any of the source outline into it',
    service: 'worker-light',
    path: 'packages/engines/src/outlines.ts',
    from: '    if len(source_root) > 0:',
    to: '    if False:  # falsify: the part is left exactly as qpdf wrote it, with no outline and no metadata',
    expect: /has no bookmark titled/,
    case: {
      tool: 'split',
      files: ['split-bookmarked-a4.pdf'],
      options: { mode: 'by-bookmarks', byBookmarks: 'level1' },
      extraArgs: ['--expect-part-outline', '0=Part 1.1'],
    },
  },
  {
    // The same decorator's page map, off by the one that a split part hides: the payload's `pages` are 1-based and
    // `page_index_in` returns a 0-based index, so a lookup that skips the conversion lands every entry one page
    // early. It reads as a *plausible* outline — which is why the assertion names a title rather than a count.
    id: 'split-part-outline-on-its-own-pages',
    invariant: 'a part’s bookmarks point at the pages they do in the part, not at the next page',
    regression: 'key the page map by 1-based page numbers while the lookups stay 0-based',
    service: 'worker-light',
    path: 'packages/engines/src/outlines.ts',
    from: '        position.setdefault(int(page) - 1, index)',
    to: '        position.setdefault(int(page), index)  # falsify: 1-based keys, 0-based lookups',
    expect: /has no bookmark titled/,
    case: {
      tool: 'split',
      files: ['split-bookmarked-a4.pdf'],
      options: { mode: 'by-bookmarks', byBookmarks: 'all' },
      // The first part is one page — source page 1 — so its own bookmark is the parent. With the map shifted, that
      // entry is dropped and its *child* takes its place, which is a part that looks bookmarked and is wrong.
      extraArgs: ['--expect-part-outline', '0=Part 1'],
    },
  },
  {
    id: 'split-packs-by-measured-size',
    invariant: '`by-size` never exceeds the target it was given, and never splits a page to do it',
    regression: 'stop consulting the target, so every page goes into one part',
    service: 'worker-light',
    path: 'workers/light/src/handlers/split.ts',
    from: '    if (current.length > 0 && currentBytes + size > targetBytes) {',
    to: '    if (false && current.length > 0 && currentBytes + size > targetBytes) {  // falsify: the target is never read',
    expect: /where the case requires 3/,
    case: {
      tool: 'split',
      files: ['split-weighted-a4.pdf'],
      options: { mode: 'by-size', bySizeMb: 0.1 },
      extraArgs: ['--expect-parts', '3', '--expect-partition', '5'],
    },
  },
  {
    // The defect this claim was written *for* (123): the engine wrapper's stdout budget is a 4 KB **log** tail, and a
    // document's object table is not a log. The fixture is 4 978 bytes of JSON, so putting the read back on the log
    // budget makes `by-size` refuse a file qpdf answered about perfectly. The fixture's size is what makes this
    // falsifiable, so shrinking its padding would silently retire the claim.
    id: 'split-measures-past-the-log-budget',
    invariant: 'measuring page weight reads the engine’s whole description, not the first 4 KB of it',
    regression: 'read qpdf’s object table through the log-tail budget',
    service: 'worker-light',
    path: 'packages/engines/src/pdf-structure.ts',
    from: "  const result = await runQpdf(['--json=1', '--json-key=pages', '--json-key=objects', path], {\n    ...opts,\n    stdoutLimitBytes: STDOUT_PAYLOAD_BYTES,\n  });",
    to: "  const result = await runQpdf(['--json=1', '--json-key=pages', '--json-key=objects', path], opts);  // falsify: the payload shares the log budget",
    expect: /the job ended as FAILED/,
    case: {
      tool: 'split',
      files: ['split-bookmarked-a4.pdf'],
      options: { mode: 'by-size', bySizeMb: 0.1 },
      extraArgs: ['--expect-parts', '3'],
    },
  },
  {
    // The same budget, one layer up: the Python bridge's stdout is a *result*, and the engine wrapper's default is a
    // 4 KB log tail. `split`'s decorator returns one object per output, so a 60-part job prints ~6.5 kB, the parse
    // fails and every part comes back with a warning (defect 126). The case is the fixture that crosses the line; the
    // sabotage puts the budget back to the log tail.
    id: 'bridge-result-fits-the-budget',
    invariant: 'a bridge that reports one result per output is not truncated by the log budget',
    regression: 'capture the Python bridge’s stdout with the 4 KB log tail',
    service: 'worker-light',
    path: 'packages/engines/src/python.ts',
    from: 'const BRIDGE_RESULT_BYTES = 8 * 1024 * 1024;',
    to: 'const BRIDGE_RESULT_BYTES = 4096;  // falsify: the result shares the log budget',
    expect: /expected the job \*\*not\*\* to report OUTPUT_NOT_DECORATED/,
    case: {
      tool: 'split',
      files: ['split-sixty-a4.pdf'],
      options: { mode: 'every-n', everyNPages: 1 },
      extraArgs: ['--expect-no-warning', 'OUTPUT_NOT_DECORATED'],
    },
  },
  {
    // The grammar in `02-SPLIT-AND-EXTRACT.md` §2, which is the shared grammar of every page-selection option in the
    // product: `2-z` is "from page 2 to the end", and the sabotage makes it resolve to the page it starts at. One
    // page instead of five, with the file valid and the job successful.
    id: 'page-range-last-page',
    invariant: '`N-z` resolves to N through the last page of the document',
    regression: 'let the last-page spelling select only the page it starts at',
    service: 'worker-light',
    path: 'packages/contracts/src/tools/page-ranges.ts',
    from: '      for (let page = start; page <= count; page += 1) pages.push(page);',
    to: '      pages.push(start);  // falsify: `N-z` means the single page N',
    expect: /expected 5 pages, found 1/,
    case: {
      tool: 'extract-pages',
      files: ['pages-six-a4.pdf'],
      options: { pages: ['2-z'] },
      extraArgs: ['--expect-pages', '5'],
    },
  },
  {
    // `bw` on PNG, which is the combination that did nothing for as long as the tool existed: the render was copied
    // through untouched and the request was answered with a warning (defect 127, pass 3). The sabotage is the old
    // behaviour exactly — "a PNG needs no conversion" — and the case fails on the *bit depth*, which is the promise.
    id: 'image-bit-depth',
    invariant: "`colorMode: 'bw'` produces a 1-bit image in a container that can hold one",
    regression: 'copy the PNG render through, as if black-and-white were applied elsewhere',
    service: 'worker-light',
    path: 'workers/light/src/handlers/pdf-to-images.ts',
    from: "    const applyNothing = options.format === 'png' && options.colorMode !== 'bw';",
    to: "    const applyNothing = options.format === 'png';  // falsify: PNG is copied, so `bw` is reported and not applied",
    expect: /is 8-bit where the case requires 1-bit/,
    case: {
      tool: 'pdf-to-images',
      files: ['pages-six-a4.pdf'],
      options: { format: 'png', dpi: 72, colorMode: 'bw', pages: ['1'] },
      extraArgs: ['--expect-image-bits', '0=1', '--expect-image-channels', '0=1'],
    },
  },
  {
    // The rotation warning, and the read behind it: `/Rotate` is *inheritable*, so the walk from the page to its
    // parent is what makes the answer about the file rather than about where the writer chose to put the value. The
    // sabotage says "no page is rotated", which is the answer a reader that only looked at page dictionaries gives for
    // a document that inherits it — a warning that never fires, on a fixture where every page carries one.
    id: 'page-rotation-warning',
    invariant: 'a page whose /Rotate the renderer applied is reported to the user',
    regression: 'read /Rotate from nowhere, so no page is ever reported as rotated',
    service: 'worker-light',
    path: 'packages/engines/src/pdf-structure.ts',
    from: "    if (typeof value === 'number' && Number.isFinite(value)) return value;",
    to: "    if (false && typeof value === 'number') return value;  // falsify: no page is ever reported as rotated",
    expect: /expected the job to report PAGE_ROTATION_NORMALIZED/,
    case: {
      tool: 'pdf-to-images',
      files: ['nup-rotated-a4.pdf'],
      options: { format: 'png', dpi: 72 },
      extraArgs: ['--expect-parts', '4', '--expect-warning', 'PAGE_ROTATION_NORMALIZED'],
    },
  },
  {
    // The blank-page warning, whose whole value is that it is *measured*: a page whose darkest pixel is pure white has
    // no ink, and its control is the same request on a document where every page has some. The sabotage removes the
    // measurement, so the warning is never emitted and the case that asks for it fails — which is the direction that
    // matters, because a warning firing on every job is a warning nobody reads.
    id: 'blank-page-warning',
    invariant: 'a rendered page with no ink at all is named in a warning',
    regression: 'skip the ink measurement, so no page is ever reported as blank',
    service: 'worker-light',
    path: 'workers/light/src/handlers/pdf-to-images.ts',
    from: '    if (index >= 0) blank.push(pageList[index] ?? index + 1);',
    to: '    if (false && index >= 0) blank.push(pageList[index] ?? index + 1);  // falsify: never reported blank',
    expect: /expected the job to report BLANK_PAGES_DETECTED/,
    case: {
      tool: 'pdf-to-images',
      files: ['pdf-to-images-blank-a4.pdf'],
      options: { format: 'png', dpi: 72 },
      extraArgs: ['--expect-parts', '3', '--expect-warning', 'BLANK_PAGES_DETECTED'],
    },
  },
  {
    // The third merge claim, and the one about a *failure* rather than an output: the sentence a user reads when the
    // engine rejects one of their files. A correct status code with a staging path in it is a leak, so this is the
    // claim that keeps the redaction load-bearing — and it needs `--expect-error-absent`, because every other flag
    // this harness has checks the code, the pages or the bytes, and all three are unchanged by the leak.
    id: 'merge-failure-names-the-file',
    invariant: 'a failed merge names the position of the offending file and nothing about the server’s disk',
    regression: 'pass the engine’s own view of the staging directory through to the user',
    service: 'worker-light',
    path: 'workers/shared/src/handlers/merge.ts',
    from: "  return redacted.replaceAll(/(?:<work>\\/|<staging>\\/|<tmp>\\/)?input\\/\\d+__/g, '').slice(0, 600);",
    // No backticks: this line is rewritten into a TypeScript file, and the handler's Python lives in a template
    // literal two files away.
    to: '  return redacted.slice(0, 600);  // falsify: the staged path reaches the user',
    expect: /mentions .*server state rather than/,
    case: {
      tool: 'merge',
      files: ['merge-two-a4.pdf', 'merge-damaged.pdf'],
      options: { bookmarks: 'keep' },
      // Both halves of the path are named, because they leak different facts: the numeric prefix says how the inputs
      // were staged, and `<work>` says where. The success half of this case is asserted in `e2e/merge.e2e.ts`.
      extraArgs: [
        '--expect-error',
        'CONVERSION_FAILED',
        '--expect-error-absent',
        'input/002__',
        '--expect-error-absent',
        '<work>',
      ],
    },
  },
  {
    // The API's page count is the number the worker checks its output against, so a wrong one is not a cosmetic
    // detail: it turns a correct merge into a failed job that blames itself. The two scan windows shared a byte,
    // which made every file smaller than the header window report twice its pages — a one-page form read as two.
    id: 'probe-page-count',
    invariant: 'the API counts a small document’s pages once, from two scan windows that do not overlap',
    regression: 'let the tail window start at the end of the file again, so a small file is counted twice',
    service: 'api',
    path: 'apps/api/src/shared/pdf-probe.ts',
    from: '  const tailSize = Math.min(size - headSize, 512 * 1024);',
    to: '  const tailSize = Math.min(size, 512 * 1024);  // falsify: the tail overlaps the header',
    // The failure is the handler's own page-count check, which is exactly the assertion that caught the defect: the
    // output is correct and the *sum of the inputs* is wrong, so no check on the delivered bytes can see it.
    expect: /the job ended as FAILED/,
    case: {
      tool: 'merge',
      // The one-page form is the whole point: at 3.5 kB it sits entirely inside the header window, so the overlap
      // counts its single `/Type /Page` object twice and the merge is refused for having the wrong number of pages.
      files: ['form-five-fields-a4.pdf', 'merge-three-a4.pdf'],
      options: { bookmarks: 'keep' },
    },
  },
  {
    id: 'printed-surface',
    invariant: 'no container prints a caller’s password',
    regression: 'log the request options before they are redacted',
    service: 'api',
    path: 'apps/api/src/services/job-service.ts',
    // The target moved when the password policy landed: the persisted options became a spread that also carries the
    // resolved plan verdict, so the mutation now logs just above that spread instead of wrapping one call. The
    // regression is identical — a password reaching a container's stdout — and the fingerprint the check looks for is
    // the value itself, which is in `secretOptions` either way.
    from: '  const persistableOptions = {',
    to: "  console.log('falsify: the options, before redaction', JSON.stringify(secretOptions));\n  const persistableOptions = {",
    expect: /was printed by a container/,
    case: {
      tool: 'encrypt',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { userPassword: 'e2e-user-secret', encryption: 'aes-128', permissions: { copy: false } },
    },
  },
  {
    id: 'durable-record',
    invariant: 'a caller’s password is never written into the job row or the queue payload',
    regression: 'persist the validated options instead of their redacted copy',
    service: 'api',
    path: 'apps/api/src/services/job-service.ts',
    // The target moved once the password policy landed: the persisted options are no longer a single call to
    // `redactSecrets` but a spread of it plus the resolved policy flag, and the mutation now removes just the
    // redaction — which is the regression the claim is about, expressed against the code that exists.
    from: '    ...redactSecrets(def, secretOptions),',
    to: '    ...secretOptions,',
    expect: /as something other than the placeholder/,
    case: {
      tool: 'encrypt',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { userPassword: 'e2e-user-secret', encryption: 'aes-128', permissions: { copy: false } },
    },
    dirties: true,
  },
  {
    id: 'password-policy',
    invariant: 'a plan that asks for a strong password is not handed a weak one',
    regression: "read the policy's plan from a constant, so every caller resolves as the free plan",
    service: 'api',
    path: 'apps/api/src/services/job-service.ts',
    from: '  const requireStrongPasswords = strongPasswordsRequired(plan, passwordOptions.requireStrongPasswords === true);',
    to: "  const requireStrongPasswords = strongPasswordsRequired('free', passwordOptions.requireStrongPasswords === true);",
    // The failure is the *refusal disappearing*, not a message changing: `abcd1234` is eight characters and two
    // classes, so under the mutation the job is accepted and completes, and the case's own expectation (a 422 with
    // `WEAK_PASSWORD`) is what reports it. That direction matters — the two cases around this one in the golden suite
    // still pass under the mutation (the floor is plan-independent and the explicit opt-in is untouched), so a claim
    // that passed on a *different* case would say nothing about the plan's rule.
    expect: /expected the job to fail with WEAK_PASSWORD/,
    case: {
      tool: 'encrypt',
      plan: 'business',
      files: ['pages-six-a4.pdf'],
      options: { userPassword: 'abcd1234', encryption: 'aes-256', permissions: { copy: false } },
      // The flag is the assertion. The first run of this claim omitted it and was reported **not-falsified** — the
      // harness ran the job, watched it complete with `WEAK_PASSWORD_ACCEPTED`, and exited 0, because without
      // `--expect-error` nothing in the case was waiting for a refusal. Same family as the absence claims: a case that
      // is not asked to check the thing cannot fail on it, and the verdict would have been a statement about the flag
      // rather than about the policy.
      extraArgs: ['--expect-error', 'WEAK_PASSWORD'],
    },
  },
  {
    id: 'redact-removal-absent',
    invariant: 'redaction removes the text rather than painting over it',
    regression: "turn the engine's content removal off, leaving the marks painted on top of the text",
    service: 'worker-heavy',
    path: 'packages/engines/src/redaction.ts',
    from: "removed = payload['removeContent']",
    to: 'removed = False',
    // The whole tool's claim, and the one a rendering check cannot make: a black rectangle over text looks identical
    // whether the glyphs underneath are gone or merely covered. `--expect-absent-text` is therefore not decoration —
    // without it the case would pass on a job that removed nothing.
    expect: /which it should not/,
    case: {
      tool: 'redact',
      plan: 'pro',
      files: ['redact-signed-a4.pdf'],
      options: { regions: [{ page: 1, rects: [{ x: 72, y: 430, w: 248, h: 14 }] }] },
      extraArgs: ['--expect-absent-text', 'ACCT-4471-9930'],
    },
  },
  {
    id: 'redact-hex-copy-is-a-leak',
    invariant: 'a copy of a removed value that survived as a hex string fails the job',
    regression:
      'search only the raw and inflated bytes, so a value that survived in a spelling nothing else reads is reported as removed',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/redact.ts',
    from: '(bytes.raw.includes(token) || bytes.inflated.includes(token) || bytes.hex.includes(token))),',
    to: '(bytes.raw.includes(token) || bytes.inflated.includes(token))),',
    // The claim the case cannot make about itself: the golden case `redact-carrier-hex` passes on the honest build by
    // refusing a job whose value survived in a carrier stream, and a case that expects a failure passes for *any*
    // failure — including one caused by this haystack being dropped and the job failing to fail. `but it completed` is
    // the verdict that says the document was reported as successfully redacted while the copy was still in it.
    expect: /but it completed/,
    case: {
      tool: 'redact',
      plan: 'pro',
      files: ['redact-carrier-hex.pdf'],
      options: { regions: [{ page: 1, rects: [{ x: 64, y: 652, w: 260, h: 40 }] }] },
      // Carried here rather than left to the golden case's own `expectError`, and that is not redundancy: this claim
      // *runs* the case, and a case with no expectation of failure passes on a job that completed — measured, with the
      // haystack dropped, which reported "the case PASSED with the regression injected" until this flag was added.
      extraArgs: ['--expect-error', 'CONVERSION_FAILED'],
    },
  },
  {
    id: 'image-only-page',
    invariant: 'a redacted page with no text layer is reported as painted over rather than erased',
    regression: 'stop asking whether the marked page had a text layer, so the warning never fires',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/redact.ts',
    from: "  const imageOnlyPages = plan.pages.filter((page) => (before.pages[page - 1] ?? '').length === 0);",
    to: '  const imageOnlyPages = plan.pages.filter(() => false);',
    // The claim guards a sentence rather than a file, which is exactly the family worth falsifying here: the run under
    // the mutation still redacts, still paints the box, still delivers a structurally correct PDF — and the user is
    // left to conclude that the black rectangle erased the pixels beneath it. `--expect-warning` is the assertion, and
    // without it the case would report success on the regressed build (defect 109 is that mistake, made once already).
    expect: /expected the job to report IMAGE_ONLY_PAGE/,
    case: {
      tool: 'redact',
      plan: 'pro',
      files: ['ocr-scan-eng-raster.pdf'],
      options: { regions: [{ page: 1, rects: [{ x: 66, y: 400, w: 380, h: 40 }] }] },
      extraArgs: ['--expect-warning', 'IMAGE_ONLY_PAGE'],
    },
  },
  {
    id: 'signature-invalidation',
    invariant: 'a document that already carries a signature is reported as invalidated by any content change',
    regression: 'make the invalidation gate return nothing, so a signed document is rewritten silently',
    service: 'worker-heavy',
    path: 'packages/engines/src/signatures.ts',
    // The gate, not the reader. A first version of this claim silenced one of the three reasons the gate has
    // (`signatureValues === 0` forced) and still reported `not-falsified` — correctly: the fixture also carries a
    // `/ByteRange`, and the gate is written so that any one of the three is enough. Measured rather than assumed, and
    // what the stage said about it is exactly what it is for.
    from: '  if (record.signatureValues === 0 && !record.byteRange && !record.perms) return null;',
    to: '  return null;',
    // The warning is the whole point of the case: the failure this guards against is not a corrupt file but a *silent*
    // one, where a user edits a signed contract, is told the job succeeded, and sends it on. A case that never asks
    // for the warning would pass against a build whose gate had stopped firing (defect 84's shape).
    expect: /expected the job to report ELECTRONIC_SIGNATURE_INVALIDATED/,
    case: {
      tool: 'redact',
      plan: 'pro',
      files: ['redact-signed-a4.pdf'],
      options: { regions: [{ page: 1, rects: [{ x: 72, y: 430, w: 248, h: 14 }] }] },
      extraArgs: ['--expect-warning', 'ELECTRONIC_SIGNATURE_INVALIDATED'],
    },
  },
  {
    id: 'sign-not-a-signature',
    invariant: 'a drawn signature is not a digital one: the output carries no signature dictionary',
    regression: 'attach a /Perms dictionary and a /Type /Sig object while writing the signature metadata',
    service: 'worker-heavy',
    path: 'packages/engines/src/signatures.ts',
    from: "    info['/Keywords'] = payload['keywords']\n    pdf.save(payload['output'])",
    to: "    info['/Keywords'] = payload['keywords']\n    pdf.Root['/Perms'] = pdf.make_indirect(pikepdf.Dictionary({'/DocMDP': pikepdf.Dictionary({'/Type': pikepdf.Name('/Sig')})}))\n    pdf.save(payload['output'])",
    // Invisible to every other check by construction: attaching a dictionary changes nothing about the rendered page,
    // the text, or the page count, so `sign`'s central claim can only be asserted from the file's own bytes.
    expect: /the output carries a signature dictionary/,
    case: {
      tool: 'sign',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        kind: 'typed',
        signature: 'Boni Patama',
        signerName: 'Boni Patama',
        reason: 'Approved the contract',
        location: 'Jakarta',
        fields: [{ page: 2, x: 100, y: 400, w: 220, h: 70 }],
      },
      extraArgs: ['--expect-no-signature-dictionary'],
    },
  },
  {
    id: 'macro-refusal',
    invariant: 'a document that carries macros is refused instead of converted',
    regression: 'stop looking for the macro carrier, so a macro-enabled workbook is converted as if it were ordinary',
    service: 'worker-office',
    path: 'workers/office/src/handlers/office-to-pdf.ts',
    from: '    const carrier = await findMacroCarrier(file.path);',
    to: '    const carrier = null as Awaited<ReturnType<typeof findMacroCarrier>>;',
    // The refusal, not the absence of execution: the case's assertion *is* the refusal, and the regex names it so a
    // failure for any other reason (a crash, a timeout) is `unexpected-failure` rather than a pass. That distinction
    // is the whole point here — the office image *has* a Basic runtime (measured: `test:isolation` runs one), so a
    // case asserting "no macro ran" would be asserting a consequence of the engine's configuration, while the
    // refusal is a decision this service makes.
    expect: /expected the job to fail with UNSUPPORTED_CONTENT/,
    case: {
      tool: 'office-to-pdf',
      files: ['office-to-pdf-macro.xlsm'],
      extraArgs: ['--expect-error', 'UNSUPPORTED_CONTENT'],
    },
  },
  {
    id: 'office-fit-to-page',
    invariant: '`fitToPage` asks the engine for one page per sheet rather than leaving its own pagination alone',
    regression:
      "send `SinglePageSheets: false` — the engine's own default — so the option changes nothing whichever way it is set",
    service: 'worker-office',
    path: 'workers/office/src/handlers/office-to-pdf.ts',
    // The value this option used to send when it was `true`. It is the whole defect in one token: a property set to
    // the value the engine already behaves as if nobody set.
    from: "    properties.SinglePageSheets = { type: 'boolean', value: 'true' };",
    to: "    properties.SinglePageSheets = { type: 'boolean', value: 'false' };",
    expect: /expected 3 pages, found 9/,
    case: {
      tool: 'office-to-pdf',
      files: ['office-to-pdf-sheets.xlsx'],
      options: { fitToPage: true },
      extraArgs: ['--expect-pages', '3'],
    },
  },
  {
    id: 'office-page-range',
    invariant: 'a `pageRange` selects the pages it names, and the pages it does not name are absent from the output',
    regression: 'stop passing the page range to the export filter, so every page of the document comes back',
    service: 'worker-office',
    path: 'workers/office/src/handlers/office-to-pdf.ts',
    from: "    properties.PageRange = { type: 'string', value: options.pageRange.replace(/\\s/g, '') };",
    to: '    // the range is recorded and not applied',
    // Absence, not the page count: a claim that looked for "one page" would pass for a handler that returned the
    // *wrong* single page, and the assertion this regression has to break is that sheet 1's marker is gone. The range
    // is left at its default `fitToPage: true` here, so the unselected workbook is three pages with every sheet in it
    // — which is the case that has to fail.
    expect: /the output contains "ALPHA SHEET MARKER", which it should not/,
    case: {
      tool: 'office-to-pdf',
      files: ['office-to-pdf-sheets.xlsx'],
      options: { pageRange: '4' },
      extraArgs: ['--expect-absent-text', 'ALPHA SHEET MARKER'],
    },
  },
  {
    id: 'office-notes-pages',
    invariant: '`slideNotes` delivers the deck’s notes pages, and only when it is asked for',
    regression:
      'send `ExportNotes` again — the property name this handler used, which the Impress export filter does not have and ignores in silence',
    service: 'worker-office',
    path: 'workers/office/src/handlers/office-to-pdf.ts',
    from: "    properties.ExportNotesPages = { type: 'boolean', value: 'true' };",
    to: "    properties.ExportNotes = { type: 'boolean', value: 'true' };",
    expect: /the output does not contain "ODP SPEAKER NOTES MARKER"/,
    case: {
      tool: 'office-to-pdf',
      files: ['office-to-pdf-notes.odp'],
      options: { slideNotes: true },
      extraArgs: ['--expect-text', 'ODP SPEAKER NOTES MARKER'],
    },
  },
  {
    id: 'html-bundle-entry-limit',
    invariant: 'a bundle past the documented entry count is refused instead of extracted',
    regression: 'never trip the entry-count bound, so a 2 001-member archive is unpacked onto the job volume',
    service: 'worker-office',
    path: 'workers/office/src/handlers/html-to-pdf.ts',
    from: '        if len(members) > MAX_ENTRIES:',
    to: '        if False and len(members) > MAX_ENTRIES:',
    // The job still fails without the guard — extraction succeeds, and something further along does not — so the
    // claim cannot expect "it completed". What it asserts is the *code*: with the bound removed the refusal is no
    // longer `UNSUPPORTED_CONTENT`, and the case says so by ending as FAILED instead of refused.
    expect: /the job ended as FAILED/,
    case: {
      tool: 'html-to-pdf',
      files: ['html-to-pdf-bundle-too-many-entries.zip'],
      extraArgs: ['--expect-error', 'UNSUPPORTED_CONTENT'],
    },
  },
  {
    id: 'remote-reference-refusal',
    invariant: 'a document that names a network resource is refused rather than fetched',
    regression: 'skip the reference scan, so the renderer is handed the URL and LibreOffice fetches it',
    service: 'worker-office',
    path: 'workers/office/src/handlers/html-to-pdf.ts',
    from: '  const blocked = await collectRemoteReferences(entries);',
    to: '  const blocked: Awaited<ReturnType<typeof collectRemoteReferences>> = [];',
    // `test:isolation` measures the other half of this invariant — that the engine *would* fetch, and that the pool
    // has no route out — because those are properties of the image and the topology, not of a case's output. This
    // claim is the handler's half, and it is the one a code change can silently remove.
    expect: /expected the job to fail with REMOTE_RESOURCES_BLOCKED/,
    case: {
      tool: 'html-to-pdf',
      files: ['html-to-pdf-remote-asset.html'],
      extraArgs: ['--expect-error', 'REMOTE_RESOURCES_BLOCKED'],
    },
  },
  {
    id: 'reveal-not-recorded',
    invariant: 'a value this job produced for its caller is never written into the job record',
    regression: 'merge the reveal into the metrics, which are persisted as JSON on the job row',
    service: 'worker-light',
    path: 'workers/shared/src/runtime.ts',
    from: '        metrics: {\n          ...(result.metrics ?? {}),',
    to: '        metrics: {\n          ...(result.metrics ?? {}),\n          ...(result.reveal ?? {}),',
    // The failure has to be the *database search*, not a shape check: the reveal still reaches the caller through Redis
    // in this mutation, so the first three questions the audit asks all answer correctly. What breaks is the fourth — a
    // generated password sitting in a column with a retention window — which is exactly the accident this channel is
    // built to make impossible, and the one that is invisible to every client-side check.
    expect: /written into a jobs row/,
    case: {
      tool: 'encrypt',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { userPassword: 'e2e-user-secret', encryption: 'aes-128', permissions: { copy: false } },
      extraArgs: ['--expect-owner-password-revealed'],
    },
    dirties: true,
  },
  {
    id: 'restrict-reveal',
    invariant: 'a restricted document hands its owner the password the service generated for it',
    regression: 'stop returning the reveal from the `restrict` handler, so the value is applied and then dropped',
    service: 'worker-light',
    path: 'workers/light/src/handlers/security.ts',
    // Re-aimed once when the password policy landed: a `weakPasswordWarnings(...)` call joined this handler's warning
    // list, so the block the mutation used to bracket no longer reads the same way. The target is the call that only
    // `restrict` makes, which keeps the claim pointed at one site — the reveal spread on its own appears in both
    // handlers, and a claim that patched whichever came first would falsify the other tool's case.
    from: "      ...weakPasswordWarnings(\n        [{ key: 'ownerPassword', value: options.ownerPassword }],\n        options.requireStrongPasswords === true,\n      ),\n    ],\n    ...(result.generatedOwnerPassword ? { reveal: { ownerPassword: result.generatedOwnerPassword } } : {}),",
    to: "      ...weakPasswordWarnings(\n        [{ key: 'ownerPassword', value: options.ownerPassword }],\n        options.requireStrongPasswords === true,\n      ),\n    ],",
    // The harness's own sentence, and the reason this claim sits beside `reveal-not-recorded` instead of being folded
    // into it: `restrict` shares an engine and a runtime with `encrypt`, so this is exactly the regression that would
    // inherit `encrypt`'s green case while leaving *this* tool's users — the ones who never set a password — holding a
    // document whose permissions nobody can change. The two mutations are also opposite directions: that one leaks the
    // value into the record, this one loses it.
    expect: /did not hand it back to its caller/,
    case: {
      tool: 'restrict',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { encryption: 'aes-256', permissions: { copy: false, modify: false } },
      extraArgs: ['--expect-owner-password-revealed'],
    },
  },
  {
    id: 'no-restriction-warning',
    invariant: 'a job that restricted nothing says so instead of reporting success',
    regression:
      'make the "nothing was denied and nothing is needed to open it" branch return before it pushes a warning',
    service: 'worker-light',
    path: 'workers/light/src/handlers/security.ts',
    from: "  if (denied.length > 0 || userPassword !== '') return [];",
    to: '  if (true as boolean) return [];',
    // The failure is the warning *disappearing* — the job still completes and its page count still matches — so the
    // case's own `--expect-warning` is the only thing that can report it. That direction is the reason the golden case
    // pairs it with `--expect-no-warning PERMISSIONS_READER_DEPENDENT`: under this mutation both are absent, and a case
    // that only asserted the absence would read as a pass.
    expect: /expected the job to report NO_RESTRICTION_APPLIED/,
    case: {
      tool: 'encrypt',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        ownerPassword: 'E2e-0wner-Secret!',
        encryption: 'aes-256',
        permissions: {
          print: true,
          printHighRes: true,
          copy: true,
          modify: true,
          annotate: true,
          fillForms: true,
          assemble: true,
          accessibility: true,
        },
      },
      extraArgs: ['--expect-warning', 'NO_RESTRICTION_APPLIED'],
    },
  },
  {
    id: 'unlock-plain-input',
    invariant: 'unlocking a file that was never encrypted succeeds and says that is what happened',
    regression:
      'report the *encrypted* branch’s warning on the branch that took a plain document, so the job describes a removal it never performed',
    service: 'worker-light',
    path: 'workers/light/src/handlers/security.ts',
    // The mutation is on the warning rather than on the branch, and the reason is worth recording: taking the branch
    // away (`if (false)`) sends an unencrypted file down the decryption path, and what pikepdf does with a password
    // against a plain document is a fact about the engine rather than about this warning — the case would then be
    // measuring something other than what its name says.
    from: "          code: 'INPUT_NOT_ENCRYPTED',",
    to: "          code: 'RESTRICTIONS_REMOVED',",
    expect: /expected the job to report INPUT_NOT_ENCRYPTED/,
    case: {
      tool: 'unlock',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { password: 'anything-at-all' },
      extraArgs: ['--expect-warning', 'INPUT_NOT_ENCRYPTED', '--expect-no-warning', 'RESTRICTIONS_REMOVED'],
    },
  },
  {
    // Pass 5's first handler claim, and the one that had no case to break before it: `-auto-orient` is the *only* thing
    // standing between a photo taken in portrait and a page that renders it on its side, and nothing in the suite had ever
    // fed this tool an image carrying an orientation tag. The mutation is the pre-139 behaviour in one word — the flag is
    // dropped — and the case fails on the page box, which is where a rotation shows up.
    id: 'exif-orientation-applied',
    invariant: 'an image whose EXIF tag rotates it is placed the way up it displays, not the way its pixels are stored',
    regression: 'stop passing -auto-orient, so a tagged photo keeps its stored orientation',
    service: 'worker-light',
    path: 'workers/light/src/handlers/images-to-pdf.ts',
    from: "    const args: string[] = [file.path, '-auto-orient', '-units', 'PixelsPerInch', '-density', '72'];",
    to: "    const args: string[] = [file.path, '-units', 'PixelsPerInch', '-density', '72'];  // falsify: the tag is never applied",
    expect: /expected a first page of 600 × 400 pt/,
    case: {
      tool: 'images-to-pdf',
      files: ['images-to-pdf-exif-6.jpg'],
      extraArgs: ['--expect-page-size', '600x400'],
    },
  },
  {
    // The frame walk: a multi-frame TIFF is turned into a multi-page intermediate by the *same* magick call that handles
    // one frame, and the assembly used to ask qpdf for page 1 of each of those documents (defect 140). The mutation is the
    // old argument — page 1 — and the case fails on the page count, which is the first thing the frames promise breaks.
    id: 'tiff-frames-all-pages',
    invariant: 'every frame of a multi-frame TIFF becomes a page, not just the first',
    regression: 'ask for page 1 of each per-image document, as the assembly did before defect 140 was fixed',
    service: 'worker-light',
    path: 'workers/light/src/handlers/images-to-pdf.ts',
    from: '      pagePaths.map((page) => ({ path: page })),',
    to: "      pagePaths.map((page) => ({ path: page, range: '1' })),  // falsify: only the first frame of each intermediate",
    expect: /expected 3 pages, found 1/,
    case: {
      tool: 'images-to-pdf',
      files: ['images-to-pdf-frames.tiff'],
      extraArgs: ['--expect-pages', '3', '--expect-media-box', '120x90', '--expect-media-box', '90x120'],
    },
  },
  {
    // The ladder, which is the whole difference between "we searched" and "we tried one setting": the *tight* target case
    // asserts that four passes ran and stopped at the floor, so cutting the ladder to one rung is a regression the case can
    // see. The never-bigger branch still returns the right file and still warns `TARGET_SIZE_UNREACHED`, which is why a case
    // that only checked the warnings and the bytes would report success on this build.
    id: 'compress-target-ladder',
    invariant: 'a target size the first pass misses is searched for down a bounded ladder, not abandoned',
    regression: 'cut the target-size ladder to its first rung, so one pass runs and the floor is never reached',
    // The *light* worker: `worker-shared` is a package rather than a container, and this tool runs on the light pool for
    // this fixture (the first version of the claim named the package and the stage refused it — no such service).
    service: 'worker-light',
    path: 'workers/shared/src/handlers/compress.ts',
    from: "    if (options.preset !== 'custom') return LADDER.slice(0, MAX_PASSES);",
    to: "    if (options.preset !== 'custom') return LADDER.slice(0, 1);  // falsify: one attempt, and the floor is never run",
    expect: /metrics\.attempts is 1, not 4/,
    case: {
      tool: 'compress',
      files: ['compress-noise-a4.pdf'],
      options: { preset: 'recommended', targetSizeMb: 0.05 },
      extraArgs: ['--expect-metric', 'attempts=4'],
    },
  },
  {
    // The form this rewrite cannot carry, and the reason the probe is load-bearing rather than decorative: the
    // delivered file is a valid PDF whose fields are gone, so only the sentence (and the metric the pair of cases
    // reads) can tell a user why the contract they just compressed has nothing to type in (defect 144).
    id: 'compress-form-dropped',
    invariant: 'a form the rewrite cannot carry is counted before the file is handed back',
    regression: 'report every input as formless, so the loss is never named',
    service: 'worker-light',
    path: 'workers/shared/src/handlers/compress.ts',
    from: '  const form = await readFormPresence(input, runOpts).catch(() => null);',
    to: '  const form = { widgets: 0, annotations: 0, acroForm: false };  // falsify: the form is never counted',
    expect: /metrics\.formFields is 0, not 6/,
    case: {
      tool: 'compress',
      files: ['form-five-fields-a4.pdf'],
      options: { stripMetadata: true, linearize: false },
      extraArgs: ['--expect-metric', 'formFields=6'],
    },
  },
  {
    // The routing rule, and the only claim here whose subject is a *decision* rather than a file. The mutation lives
    // in the `api` container because the API is the first of the two places the rule is applied: it routes on the size
    // the upload claimed. The worker's copy of the same function is left alone on purpose — it re-routes on the real
    // sizes, so under this regression the job still *ends* on heavy with a 420 s budget. That is exactly why the case
    // asserts the queue the job was **accepted** on: the acceptance is the half that can only be right if the API's
    // decision was, and without it a broken threshold would look like a working one by the time the job finished.
    id: 'escalation-page-threshold',
    invariant: 'a job above a tool’s page threshold is accepted on the pool that threshold names',
    regression: 'ignore the page threshold, so a 320-page job is accepted on the light pool',
    service: 'api',
    path: 'packages/contracts/src/tools/types.ts',
    from: '  if (esc.abovePages != null && (claimed.pages ?? 0) > esc.abovePages) return esc.queue;',
    to: '  // falsify: the page threshold is not consulted\n  if (false && esc.abovePages != null && (claimed.pages ?? 0) > esc.abovePages) return esc.queue;',
    expect: /the job was accepted on pdf-light, not pdf-heavy/,
    case: {
      tool: 'compress',
      plan: 'pro',
      files: ['compress-large-320p.pdf'],
      options: { stripMetadata: true, linearize: false },
      extraArgs: ['--expect-queue', 'pdf-heavy'],
    },
  },
  {
    // The byte twin of `escalation-page-threshold`, and the only reason the pair is two claims rather than one: the two
    // thresholds are separate lines of the same function, so a regression that stopped consulting **either** would keep
    // the other's case green. The mutation removes the byte half alone, and the fixture it removes it for is a two-page
    // document — whose page count cannot cross the page threshold — so the case can only fail here by having been
    // routed on its size.
    //
    // It also falsifies the *stack* half of the case's premise: the file has to be accepted by the API at all for the
    // routing to be observable, which is what `plan: 'pro'` (300 MB per file) and the raised upload ceiling are for
    // (`0-CICD.md` §3). Under this mutation that ceiling has to hold, otherwise the claim would report a stack
    // limitation as a caught regression.
    //
    // The ceiling is therefore **declared**, not assumed — and finding that out cost a run: without
    // `--require-upload-ceiling-mb` the harness reports the 413 as an ordinary failure, which this runner reads as
    // `unexpected-failure` ("the case failed, but not for the reason the claim asserts") against a stack that is
    // working correctly. The flag is what turns that into the gap `--only` prints as "could not run on this stack".
    id: 'escalation-byte-threshold',
    invariant: 'a job above a tool’s byte threshold is accepted on the pool that threshold names',
    regression: 'ignore the byte threshold, so a 110 MB job is accepted on the light pool',
    service: 'api',
    path: 'packages/contracts/src/tools/types.ts',
    from: '  if (esc.aboveBytes != null && (claimed.bytes ?? 0) > esc.aboveBytes) return esc.queue;',
    to: '  // falsify: the byte threshold is not consulted\n  if (false && esc.aboveBytes != null && (claimed.bytes ?? 0) > esc.aboveBytes) return esc.queue;',
    expect: /the job was accepted on pdf-light, not pdf-heavy/,
    case: {
      tool: 'compress',
      plan: 'pro',
      files: ['compress-over-100mb.pdf'],
      options: { stripMetadata: true, linearize: false },
      extraArgs: ['--expect-queue', 'pdf-heavy', '--require-upload-ceiling-mb', '100'],
    },
  },
  {
    // The **worker's** half of routing, which no other claim touches: the two above are about the decision the API
    // makes from the claim, and this one is about the decision the worker makes from the files.
    //
    // The mutation restores the behaviour defect 153 found — re-use the payload's number, which is the number the API
    // already routed on — and the case must notice, because its fixture is a document the API's byte scan cannot size
    // at all (620 pages behind a 600 KB padding tail). Under the mutation the job stays on `pdf-light` with the light
    // pool's 300 s budget and the case fails naming that: the worker did not move it.
    //
    // Patching the **light** image is what makes it observable: the light worker is the one that claims the job, so
    // it is the one whose re-check would have to move it. Nothing about the harness needs a second response here —
    // the assertion is the job's own record, which is the answer the second decision writes down.
    id: 'worker-reroute-measured-pages',
    invariant: 'a job whose real page count crosses a tool’s threshold is moved to the pool that threshold names',
    regression:
      're-use the page count the API already routed on, so a file the byte scan could not size stays on the light pool',
    service: 'worker-light',
    path: 'workers/shared/src/runtime.ts',
    from: '    const measured = await countPdfPages(file.path, opts);',
    to: '    // falsify: the re-check does not read the file\n    const measured = 0;',
    expect: /the worker did not move it/,
    case: {
      tool: 'compress',
      plan: 'pro',
      files: ['compress-hidden-pages-620p.pdf'],
      options: { stripMetadata: true, linearize: false },
      extraArgs: ['--expect-queue', 'pdf-light', '--expect-final-queue', 'pdf-heavy'],
    },
  },
  {
    // The **plan's** page ceiling, which is the other half of what that fixture found (defect 154) and the half no other
    // claim touches.
    //
    // The mutation is the pre-change state exactly: the ceiling never reaches the job. Before `planMaxPages` existed the
    // comparison a worker could make was against `limits.maxPages`, which is the *tool's* cap from the catalogue and `0`
    // for every tool in the registry — so a rule about a plan was compared against a constant that could not move, and
    // the document here (620 pages the API's byte scan cannot size, on a Free account whose limit is 500) ran to
    // completion: 620 pages in, 620 out.
    //
    // Patching the **API** is what makes this one observable with a single mutation: the number is resolved there and
    // only there, so a job carrying `0` cannot be refused by either worker *and* leaves the four handler-side checks
    // inert — which is the same statement as "the ceiling did not travel", not a weaker one. The case's own premise
    // (`--expect-queue pdf-light`, the API accepting what it could not size) still holds under the patch, so the failure
    // the claim expects is the assertion about the refusal, not a collision with the routing rule above it.
    id: 'plan-page-ceiling-in-payload',
    invariant: 'a job is refused against its plan’s page ceiling even when the API could not count the pages',
    regression:
      'send no plan page ceiling with the job, so the limit is skipped for exactly the documents it cannot size',
    service: 'api',
    path: 'apps/api/src/services/job-service.ts',
    from: '          planMaxPages: limits.maxPages,',
    to: '          planMaxPages: 0,\n          // falsify: the plan’s ceiling does not travel with the job',
    expect: /expected the job to fail with PAGE_LIMIT_EXCEEDED_JOB but it completed/,
    case: {
      tool: 'compress',
      plan: 'free',
      files: ['compress-hidden-pages-620p.pdf'],
      options: { stripMetadata: true, linearize: false },
      extraArgs: ['--expect-queue', 'pdf-light', '--expect-error', 'PAGE_LIMIT_EXCEEDED_JOB'],
    },
  },
  {
    // The spelling half of routing, and the reason the harness reads two responses instead of one. The mutation does
    // **not** break the decision — the job is still accepted on, and runs on, `pdf-heavy`; it makes the *answer*
    // disagree with the record, which is the shape the create response had before it returned the queue name. A case
    // that only read `POST /jobs` (every case before this one) could not tell the two apart, and neither could a user:
    // the submit page and the job page would have shown different pools for the same job.
    id: 'accepted-queue-spelling',
    invariant: 'the queue a job is accepted on is the queue the job reports',
    regression: 'answer `POST /jobs` with the pool id while the record keeps the queue name',
    service: 'api',
    path: 'apps/api/src/services/job-service.ts',
    from: "    status: 'QUEUED',\n    queue: queueForTool(queue),\n    priority,\n    estimatedSeconds:",
    to: "    status: 'QUEUED',\n    queue,\n    priority,\n    estimatedSeconds:",
    expect: /the acceptance response named heavy as the queue — that is a pool id/,
    case: {
      tool: 'compress',
      plan: 'pro',
      files: ['compress-large-320p.pdf'],
      options: { stripMetadata: true, linearize: false },
    },
  },
  {
    // Per-page rotation, which no case had ever measured before pass 5 — `rotate`'s three cases asserted page counts and a
    // warning, all of which a job that rotated nothing satisfies. The mutation drops the map (the pre-139 shape of the
    // option: declared in the contract, rendered in the form, read by nobody), and the case sees it as the *default* angle
    // appearing on pages nobody asked to rotate.
    id: 'rotate-per-page-map',
    invariant: '`perPage` rotates the pages it names and leaves the rest alone',
    regression: 'ignore the per-page map, so every page takes the single default angle instead',
    service: 'worker-light',
    path: 'workers/light/src/handlers/rotate.ts',
    from: '  const perPage = options.perPage ?? {};',
    to: '  const perPage: Record<string, 90 | 180 | 270> = {};  // falsify: the map is ignored',
    // Page **1**, and the reason is a property of the harness rather than of the handler: the expectations arrive as a
    // record keyed by page number, and JavaScript orders integer-like keys ascending whatever order they were inserted in
    // — so the first assertion is the lowest page, which under this regression has picked up the default angle. Measured,
    // not assumed: the claim's first version expected the page-2 message and the stage reported "failed, but not for the
    // reason the claim asserts", which is exactly the verdict an over-specific expectation should get.
    expect: /page 1 should carry \/Rotate 0, and the file says 90/,
    case: {
      tool: 'rotate',
      files: ['pages-six-a4.pdf'],
      options: { perPage: { '2': 180, '5': 270 } },
      extraArgs: ['--expect-page-rotate', '2=180', '--expect-page-rotate', '5=270', '--expect-page-rotate', '1=0'],
    },
  },
  {
    // The reordering tool's half of the claim `split`/`extract-pages`/`delete-pages` already carry: its output is
    // assembled by the same `--empty --pages` call, so without the decoration step it ships with the empty outline
    // qpdf wrote — and with nothing to say about it (defect 143). The mutation is the pre-fix handler: the decoration
    // result is replaced by an empty one, which leaves the pages, the order and the page count all correct.
    id: 'reorder-outline-lifted',
    invariant: 'a reordered document keeps its bookmarks, remapped onto the page numbers the new order gives them',
    regression: 'skip the decoration step, so the output keeps the outline qpdf left — none',
    service: 'worker-light',
    path: 'workers/light/src/handlers/pages.ts',
    from: '  const decorated = await decorate(input, outputPath, pageList, runOpts);',
    to: '  const decorated = { entries: 0, warnings: [] };  // falsify: nothing is lifted onto the reordered document',
    // The failure has to name the missing title: with the outline gone, the page count, the page order and the page
    // text are all still correct, so only the outline assertion can see it.
    expect: /no bookmark titled/,
    case: {
      tool: 'reorder-pages',
      files: ['bookmark-toc.pdf'],
      options: { order: [3, 1, 2] },
      extraArgs: ['--expect-outline', 'Chapter 1'],
    },
  },
  {
    id: 'pdfa-conformance',
    invariant: 'an archival file is validated before it is delivered',
    regression: 'take the "not validated" branch unconditionally, so a file is delivered on its own metadata claim',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-pdfa.ts',
    from: '  if (config.pdfaValidate) {',
    to: '  if (false as boolean) {',
    // The case asserts what the job says about its own output, and the failure is that the metric moved rather than
    // that a check crashed: with the validator skipped, the job completes and reports `NOT_VALIDATED`. That wording is
    // the point — the file still has its XMP claim and its output intent, so everything a byte scan can see is
    // unchanged, and only the claim about *conformance* distinguishes a validated file from one nobody opened.
    expect: /metrics\.conformance\.result/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { profile: '2b' },
      extraArgs: ['--expect-metric', 'conformance.result="PASS"'],
    },
  },
  {
    // The census, which is what turned a fixed three-entry `changes` list into a measurement of the caller's document.
    // The regression makes `pdffonts` report nothing but embedded fonts — the shape the parser had by accident before
    // the object-ID offset was fixed, and one no byte scan can see, since it changes no property of the output file.
    //
    // The case asserts `fontsEmbedded` is **above** zero rather than equal to a number: the count is a property of the
    // fixture (one font, no program), and restating it would be asserting the fixture twice. What the case actually
    // claims is that the tool noticed a font without a program — so a census that stopped counting fails it.
    id: 'pdfa-font-census',
    invariant: 'the job knows which of the input fonts had no font program',
    regression: 'stop counting non-embedded fonts, so the census reports every font as embedded',
    service: 'worker-heavy',
    path: 'packages/engines/src/pdfa.ts',
    from: "    if (embedded === 'no') census.notEmbedded += 1;",
    to: '    // falsify: a font without a program is counted as embedded',
    expect: /metrics\.fontsEmbedded is 0, not above 0/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { profile: '1b' },
      extraArgs: ['--expect-metric-over', 'fontsEmbedded=0'],
    },
  },
  {
    // The image threshold, and the case is a single fixture carrying a 720 dpi image beside a 100 dpi one for exactly
    // this: counting every image makes the number 2 instead of 1 (an engine that "reduced everything" would pass a
    // case that only asked for "more than none"), and counting none makes it 0.
    //
    // The regression is the threshold read as "any image at all", which is what a census without a threshold does —
    // and the flag the handler passes (`-d*ImageDownsampleThreshold=1.0`) is what makes the threshold a fact about the
    // engine too rather than a number this project chose on its own.
    id: 'pdfa-image-threshold',
    invariant: 'only the images above the normalising resolution are counted as reduced',
    regression: 'treat every embedded image as above the threshold, so the control image is reported as reduced too',
    service: 'worker-heavy',
    path: 'packages/engines/src/pdfa.ts',
    from: '    if (highest > dpi) census.aboveDpi += 1;',
    to: '    census.aboveDpi += 1;  // falsify: the control image counts as reduced',
    expect: /metrics\.imagesDownsampled is 2, not 1/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pdf-to-pdfa-images-a4.pdf'],
      options: { profile: '2b' },
      extraArgs: ['--expect-metric', 'imagesDownsampled=1'],
    },
  },
  {
    // `embedAllFonts`, which was declared, defaulted to `true` and never read for as long as the option existed. Its
    // effect is that one prepass does not run, and that changes nothing about the delivered file (measured: the PDF/A
    // pass embeds fonts itself), so the job's own account of which pass ran is the only place it can be observed.
    //
    // The regression is the old behaviour exactly: always run the prepass. The case then reports `fontPass: 'embed'`
    // and fails, while its output is byte-valid archival — which is the point of asserting the metric rather than the
    // file.
    id: 'pdfa-embed-all-fonts',
    invariant: '`embedAllFonts: false` really skips the font-embedding prepass',
    regression: 'ignore the flag and always run the prepass, which is what the option did before it was read',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-pdfa.ts',
    from: '  if (options.embedAllFonts) {',
    to: '  if (true) {  // falsify: the option is not consulted',
    expect: /metrics\.fontPass is "embed", not "skipped"/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { profile: '2b', embedAllFonts: false },
      extraArgs: ['--expect-metric', 'fontPass="skipped"'],
    },
  },

  {
    // The preamble, dropped from the command line — the refactor a reader would call harmless, since the argument list
    // is eleven flags and one file name.
    //
    // It is not harmless: without the PostScript prefix program Ghostscript writes the XMP claim and no output intent,
    // exits **0**, and the file that comes out claims PDF/A and is not (`09-PDF-A.md` §4 — the defect this tool was
    // written to fix). Nothing outside the file can see it, so the only thing standing between that regression and a
    // delivered non-archival document is the read-back, and this claim is what proves the read-back is what refuses.
    id: 'pdfa-intent-read-back',
    invariant: 'a file with no output intent is not delivered, even though Ghostscript exits 0',
    regression: 'stop passing the output-intent preamble, so the pass produces a claim with no intent behind it',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-pdfa.ts',
    from: '      intentPath,\n      downsampled,',
    to: '      downsampled,  // falsify: the preamble is no longer supplied',
    expect: /CONVERSION_FAILED/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { profile: '1b' },
    },
  },
  {
    // The XMP half of the same promise, and the one that used to be a sentence rather than a reading: the change list
    // said "pdfaid:part/conformance set for profile 2b" because the pass was *asked* for 2b, whether or not the
    // delivered file said so.
    //
    // The regression makes the identification read as a level nobody asked for — the shape of the historical
    // `-dPDFA=3` answered with a PDF/A-2 file — and the read-back is what has to refuse it.
    id: 'pdfa-claim-read-back',
    invariant: 'a file whose own metadata declares a level other than the one requested is not delivered',
    regression: "read the delivered file's pdfaid level as something else, so the file claims a level nobody asked for",
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-pdfa.ts',
    from: '  const claim = readPdfaClaim(deliveredBytes);',
    to: "  const claim = { part: '2', conformance: 'B' };  // falsify: the file's own declaration is not read",
    expect: /CONVERSION_FAILED/,
    case: {
      tool: 'pdf-to-pdfa',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: { profile: '1b' },
    },
  },

  // ── the extraction chapter's four (pass 8) ────────────────────────────────────────────────────────────────────
  //
  // `08-PDF-TO-OFFICE-AND-TEXT.md` had **zero** claims before these, which made it the only group whose coverage was
  // "the cases are green" rather than "the cases can go red" — the same finding pass 9 made about the four editing
  // tools above. Each one below targets a decision that a case asserts and
  // a reader would have to take on faith otherwise: a refusal, a flag that selects between engines, an option that
  // changes one line of markup, and a branch that writes a different workbook.
  {
    // The claim the whole tool rests on, and the one a naive implementation gets wrong by returning whatever the engine
    // wrote: `pdftotext` exits 0 on a scan and produces an empty file, so a handler that only checked the exit code
    // reports success for a document it read nothing from. The mutation makes the guard unreachable, which leaves the
    // job *succeeding* with a 0-byte text file — exactly the outcome the refusal exists to prevent.
    id: 'text-empty-extraction-refused',
    invariant: 'a document with no text layer is refused rather than delivered as an empty file',
    regression: 'make the empty-extraction guard unreachable, so a scan becomes a successful job with no text in it',
    service: 'worker-light',
    path: 'workers/light/src/handlers/pdf-to-text.ts',
    from: '  if (characters <= NO_TEXT_THRESHOLD) {',
    to: '  if (false as boolean) {  // falsify: nothing is refused, so the empty file is the result',
    expect: /expected the job to fail with UNSUPPORTED_CONTENT but it completed/,
    case: {
      tool: 'pdf-to-text',
      files: ['ocr-scan-eng-raster.pdf'],
      extraArgs: ['--expect-error', 'UNSUPPORTED_CONTENT'],
    },
  },
  {
    // `allTables: false` choosing the **largest** table, which is a decision inside the Python the handler runs rather
    // than a branch in TypeScript — so it is the kind of thing a refactor of that script can lose without touching any
    // assertion about parts. The mutation is the pre-option shape: every table that survived the minimum-size filter is
    // written, and the document has two of different sizes, so "kept the largest" becomes "kept both".
    id: 'csv-alltables-largest-only',
    invariant: '`allTables: false` writes the largest table alone, not every table it found',
    regression: 'ignore the flag, so a document with two tables returns two CSVs where the caller asked for one',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-csv.ts',
    from: "if not payload['allTables'] and kept:",
    to: 'if False and kept:  # falsify: the flag is ignored, so every table is written',
    expect: /lists 2 part\(s\) where the case requires 1/,
    case: {
      tool: 'pdf-to-csv',
      files: ['tables-mixed-a4.pdf'],
      options: { tableStrategy: 'ruled', allTables: false },
      extraArgs: ['--expect-parts', '1'],
    },
  },
  {
    // `responsive`, whose entire visible product is one `<meta>` in the head. Nothing else about the file changes, so a
    // handler that dropped the option would produce a document nobody could tell apart by page count, text or size —
    // which is why the assertion is a byte search for the tag itself and why the mutation is "never emit it".
    id: 'html-responsive-viewport',
    invariant: '`responsive: true` puts a viewport meta in the reflowed page',
    regression: 'emit no viewport meta whatever the caller asked, so a phone lays the page out at desktop width',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-html.ts',
    from: '  const viewport = ctx.responsive ? \'\\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\' : \'\';',
    to: "  const viewport = '';  // falsify: the option is ignored",
    // The tag is *not* spelled in the pattern, and the reason is the harness's own formatting rather than caution: the
    // failure line prints the wanted string through `JSON.stringify`, so the quotes inside `name="viewport"` arrive
    // escaped and the literal would not match. What is specific here is the assertion, which only `expectBytes` makes.
    expect: /is missing from the output, but this case expects it to survive/,
    case: {
      tool: 'pdf-to-html',
      files: ['pages-six-a4.pdf'],
      options: { mode: 'reflow', responsive: true },
      extraArgs: ['--expect-bytes', '<meta name="viewport"'],
    },
  },
  {
    // `oneSheetPerPage`, which selects between two shapes of the *same* workbook: one sheet per table (named after the
    // table and its page) against one sheet per page. The sheet names are the entire difference a reader can see, and
    // the mutation collapses the branch so the per-table naming is written even when the caller asked for per-page.
    //
    // The case needs the mixed fixture: on a one-page single-table document both branches produce a byte-identical
    // workbook (measured), so the flag could be ignored without any assertion moving.
    id: 'office-onesheetperpage-branch',
    invariant: '`oneSheetPerPage: true` names one worksheet per page instead of one per table',
    regression: 'ignore the flag, so the workbook is always one sheet per table',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/pdf-to-office.ts',
    from: "        elif payload['oneSheetPerPage']:",
    to: '        elif False:  # falsify: the flag is ignored, so one sheet per table whatever was asked',
    expect: /"page-1" is not in any entry of the archive/,
    case: {
      tool: 'pdf-to-office',
      files: ['tables-mixed-a4.pdf'],
      options: { target: 'xlsx', oneSheetPerPage: true },
      extraArgs: ['--expect-archive-text', 'page-1', '--expect-archive-text', 'page-3'],
    },
  },

  // ── the recognition chapter's ten (pass 10) ──────────────────────────────────────────────────────────────────
  //
  // `15-OCR.md` was the last single-tool document with **no claim of its own** — one golden case, and nothing that
  // could go red. Ten sentences in it turned out to be wrong, and five of the ten below guard a *transport* rather
  // than a conversion: two of the three output modes could not run at all, an image input could not be read, a page
  // selection was silently ignored, and a second document was silently dropped. The other five guard an option that
  // reached nothing (`dpi`, `clean`, `pages`), a warning whose whole value is the page it names, and the image merge.
  //
  // The container is `worker-ocr`, which no claim had ever targeted; the case each one is aimed at is the pair in
  // `scripts/ci/golden.ts`, so the failure it must report is the missing half rather than a crash.
  //
  // Every case below carries its assertions in `extraArgs`, and that is not decoration: the first run of these ten
  // claims had the `ocr-dpi-oversample`, `ocr-clean-flag`, `ocr-partially-recognised-pages` and `ocr-image-merge-pages`
  // cases **pass with the regression injected** — the harness only compares a metric, a warning or an absence when it
  // is asked to, so a case declared with nothing but `tool`, `files` and `options` asserts almost nothing. Four of the
  // ten claims were therefore testing the *transport* and not the sentence they name. The flags are spelled the way
  // `scripts/ci/golden.ts` spells them when it translates a case (defect 176).
  {
    // An image input. The mutation hands the PNG to the PDF reader exactly as the old handler did, which is the shape
    // of defect 172: `qpdf --show-npages` exits 2 on an image, so the job fails `INVALID_FILE` and the case never sees
    // its text.
    id: 'ocr-image-input-converted',
    invariant: 'an image input is placed on a page before recognition, so a PNG is a page like any other',
    regression: 'hand the image straight to the PDF reader, as the handler did before the conversion step existed',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: '    input = built;',
    to: '    input = images[0]!.path; // falsify: the PNG goes to qpdf, which cannot read it',
    expect: /the job ended as FAILED/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-eng.png'],
      extraArgs: ['--expect-pages', '1', '--expect-text', 'fixture'],
    },
  },
  {
    // The merge. Every image after the first is dropped, and the case's own second-page label is what notices: a
    // one-page PDF still contains the first page's words, so only the *count* and the second label can tell.
    id: 'ocr-image-merge-pages',
    invariant: 'several images become several pages, in the order they were uploaded',
    regression: 'embed only the first image, so a multi-image job quietly loses the rest',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: '        files: images.map((file) => file.path),',
    to: '        files: images.slice(0, 1).map((file) => file.path), // falsify: one image, one page',
    expect: /expected 2 pages, found 1/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-two-p1.png', 'ocr-scan-two-p2.png'],
      extraArgs: ['--expect-pages', '2', '--expect-text', 'page 2 of 2'],
    },
  },
  {
    // The page nobody could read. The mutation keeps the warning from ever firing, which is the state the document
    // was in from the beginning: it listed `PAGE_PARTIALLY_RECOGNISED` while no code could raise it.
    id: 'ocr-partially-recognised-pages',
    invariant: 'a page the recogniser could not read is named in the report',
    regression: 'stop looking at the per-page text, so the warning can never fire',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "  const pagesWithoutText = judged.filter((page) => (pageTexts[page - 1] ?? '').trim().length === 0);",
    to: '  const pagesWithoutText: number[] = []; // falsify: every page is assumed recognised',
    expect: /metrics.pagesWithoutText is \[\], not \[2\]/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-blank-a4.pdf'],
      extraArgs: ['--expect-warning', 'PAGE_PARTIALLY_RECOGNISED', '--expect-metric', 'pagesWithoutText=[2]'],
    },
  },
  {
    // `clean`, and the observable is the recognition itself: at 2 % speckle the noisy page is misread as "page tof"
    // where it says "page 1 of 1", so dropping the flag from the argument list is visible in the output's own words.
    id: 'ocr-clean-flag',
    invariant: '`clean: true` despeckles before recognition, and the flag reaches the engine',
    regression: 'drop `--clean` from the argument list, so the option is a metric and nothing else',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "    ...(options.clean ? ['--clean'] : []),",
    to: '    // falsify: the flag never reaches ocrmypdf',
    expect: /the output does not contain "page 1 of 1"/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-speckle-a4.png'],
      options: { clean: true },
      extraArgs: ['--expect-text', 'page 1 of 1', '--expect-metric', 'clean=true'],
    },
  },
  {
    // `dpi`, and `oversampleDpi` is the assertion that can reach it: a value that never arrives is `null` on a 300 dpi
    // page, which is exactly what the automatic rule produces when the option is ignored.
    id: 'ocr-dpi-oversample',
    invariant: 'an explicit `dpi` is what the recognition runs at, and the report says which value it used',
    regression: 'ignore the option and let the automatic path decide, so 600 dpi is never handed to the engine',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: '    options.dpi ??\n',
    to: '    null ?? // falsify: the option is ignored\n',
    expect: /metrics.oversampleDpi is null, not 600/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-eng-raster.pdf'],
      options: { dpi: 600 },
      extraArgs: ['--expect-metric', 'oversampleDpi=600', '--expect-text', 'fixture'],
    },
  },
  {
    // The page selection. `--pages` is what limits recognition, so removing it recognises every page — and the case
    // asserts the *absence* of page 3's own words, which is the only assertion that can see it.
    id: 'ocr-pages-selection',
    invariant: 'a page selection limits recognition to the pages the caller named',
    regression: 'drop `--pages`, so every page is recognised however the caller asked',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "    ...(selected ? ['--pages', selected.join(',')] : []),",
    to: '    // falsify: the selection never reaches ocrmypdf',
    expect: /the output contains "page 3 of 3", which it should not/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-blank-a4.pdf'],
      options: { pages: ['1'] },
      extraArgs: [
        '--expect-absent-text',
        'page 3 of 3',
        '--expect-text',
        'page 1 of 3',
        '--expect-metric',
        'pagesSelected=1',
      ],
    },
  },
  {
    // The text-only mode's required positional. Without it OCRmyPDF exits 2 — which the caller saw as
    // `CONVERSION_FAILED` for a mode the document described as working (defect 171, first half).
    id: 'ocr-text-mode-positional',
    invariant: 'it is the mode the caller asked for, not a different one that happens to succeed',
    regression: 'remove the `-` positional, so `--output-type none` fails in argument parsing',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "    await ocrmypdfOrThrow([...commonFlags, '--sidecar', sidecarPath, '--output-type', 'none', input, '-'], runOpts);",
    to: "    await ocrmypdfOrThrow([...commonFlags, '--sidecar', sidecarPath, '--output-type', 'none', input], runOpts); // falsify: no output positional",
    expect: /the job ended as FAILED/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-eng-raster.pdf'],
      options: { outputMode: 'text-only' },
      extraArgs: ['--expect-kind', 'text', '--expect-parts', '1', '--expect-part-text', '0=fixture'],
    },
  },
  {
    // The sidecar's directory. `verifyOutputs` stats `join(outputDir, name)`, so a sidecar written to the work
    // directory is a declared output that does not exist — the second half of defect 171, and the reason `sidecar`
    // and `pdf-and-text` failed with "reported success but produced no usable output".
    id: 'ocr-sidecar-in-output-dir',
    invariant: 'every declared output is written where the runtime looks for it',
    regression: 'write the sidecar beside the work files instead of beside the deliverable',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "  const sidecarPath = join(outputDir, 'ocr-text.txt');",
    to: "  const sidecarPath = join(workDir, 'ocr-text.txt'); // falsify: the runtime never looks here",
    expect: /produced no usable output/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-eng-raster.pdf'],
      options: { sidecar: true },
      extraArgs: ['--expect-parts', '2', '--expect-part-text', '1=fixture'],
    },
  },
  {
    // The verification's reader. `text-only` produces text, so reading it with `pdftotext` reports every successful
    // job as a failure — the third layer of the same defect, and the one that would have survived the other two.
    id: 'ocr-text-mode-reads-text',
    invariant: 'the verification reads the product it produced',
    regression: 'verify the sidecar as if it were a PDF, so a correct text job is reported as unreadable',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: "      ? (await readFile(sidecarPath, 'utf8').catch(() => '')).trim()",
    to: "      ? '' // falsify: the text is never read, so no text can be recognised",
    expect: /the job ended as FAILED/,
    case: {
      tool: 'ocr',
      files: ['ocr-scan-eng-raster.pdf'],
      options: { outputMode: 'text-only' },
      extraArgs: ['--expect-part-text', '0=fixture'],
    },
  },
  {
    // Two documents. The rule exists because the handler used to read `files[0]` and ignore the rest, so a two-document
    // job looked like a success that had dropped an input. Removing the refusal restores exactly that.
    id: 'ocr-second-document-refused',
    invariant: 'a job the tool cannot honour is refused rather than half-done',
    regression: 'drop the multi-document rule, so the second document is silently ignored',
    service: 'worker-ocr',
    path: 'workers/ocr/src/handlers/ocr.ts',
    from: '  if (documents.length > 1 || (documents.length > 0 && images.length > 0)) {',
    to: '  if (false && (documents.length > 1 || (documents.length > 0 && images.length > 0))) { // falsify',
    expect: /expected the job to fail with VALIDATION_ERROR but it completed/,
    case: {
      tool: 'ocr',
      files: ['merge-two-a4.pdf', 'merge-three-a4.pdf'],
      extraArgs: ['--expect-error', 'VALIDATION_ERROR'],
    },
  },

  // ── the editing chapter's eight (pass 9) ───────────────────────────────────────────────────────────────────────
  //
  // Four of the six tools in `13-EDIT-AND-ANNOTATE.md` and `14-SIGN-AND-FORMS.md` — `edit-pdf`, `annotate`,
  // `fill-form`, `extract-fields` — carried **no claim at all** before this pass; `redact` and `sign` had four between
  // them, over the sentences they share with every content-changing tool. The claims below target the three families a
  // reader would otherwise have to take on faith: a sentence about the caller's own coordinates, a limit that exists
  // only as a number in a table, and an invariant that is a *difference* between two files rather than a property of
  // one. The contract-side claim comes last in the group on purpose: it patches the API rather than a worker, and the
  // runner recreates the container each claim touches.
  {
    // A mark that hangs off the page, which every tool in this build can be handed and only one of them used to report.
    // The mutation makes the sentence unreachable — and the case still asserts the job *succeeded*, the page count, and
    // (through `--expect-warning`) the words: without that flag the harness would report success on a build that drew
    // the mark past the paper's edge and said nothing, which is the defect this claim exists to keep impossible.
    id: 'edit-off-page-warning',
    invariant: 'an element that only partly lands on its page is reported rather than drawn silently',
    regression: 'make the off-page check unreachable, so a mark beyond the paper is drawn and not mentioned',
    service: 'worker-light',
    path: 'workers/light/src/handlers/edit-pdf.ts',
    from: '  if (offPage.length > 0) {',
    to: '  if (false as boolean) {  // falsify: the caller is never told their mark left the page',
    expect: /expected the job to report ELEMENT_OFF_PAGE/,
    case: {
      tool: 'edit-pdf',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        elements: [{ type: 'shape', shape: 'rect', page: 1, x: 300, y: -20, width: 200, height: 60, fill: '#ff00ff' }],
      },
      extraArgs: ['--expect-warning', 'ELEMENT_OFF_PAGE'],
    },
  },
  {
    // The same sentence one tool over, and the same mutation: `annotate`'s marks are a *dictionary* rather than paint,
    // so a case that only counted annotations would pass on a build that had stopped measuring the caller's rectangles.
    id: 'annotate-off-page-warning',
    invariant: 'an annotation that only partly lands on its page is reported rather than written silently',
    regression: 'make the off-page check unreachable, so a mark beyond the paper is written and not mentioned',
    service: 'worker-light',
    path: 'workers/light/src/handlers/annotate.ts',
    from: '  if (offPage.length > 0) {',
    to: '  if (false as boolean) {  // falsify: the caller is never told their mark left the page',
    expect: /expected the job to report ELEMENT_OFF_PAGE/,
    case: {
      tool: 'annotate',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        annotations: [
          { type: 'highlight', page: 3, rects: [{ x: 500, y: -12, width: 200, height: 40 }], color: '#000000' },
        ],
      },
      extraArgs: ['--expect-warning', 'ELEMENT_OFF_PAGE'],
    },
  },
  {
    // The 4 MB ceiling on an element image, which is the one rule here that a schema cannot express: it is the size of
    // a file the API resolved, not a number in the payload. The mutation removes the check, and the fixture is built so
    // the job then *succeeds* — 1200×1200 is an ordinary bitmap and its 4.1 MB is the only thing over any limit, so
    // "the refusal disappeared" is the whole failure.
    id: 'edit-image-byte-cap',
    invariant: 'an element image larger than 4 MB is refused before it is embedded',
    regression: 'remove the per-element image size check, so an oversized bitmap is embedded and the job succeeds',
    service: 'worker-light',
    path: 'workers/light/src/handlers/edit-pdf.ts',
    from: '      if (bytes > MAX_ELEMENT_IMAGE_BYTES) {',
    to: '      if (false as boolean) {  // falsify: any size of image is embedded',
    expect: /expected the job to fail with VALIDATION_ERROR but it completed/,
    case: {
      tool: 'edit-pdf',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        elements: [
          {
            type: 'image',
            page: 1,
            x: 72,
            y: 200,
            width: 120,
            height: 120,
            fileId: '@upload:fixtures/generated/element-image-oversize.png',
          },
        ],
      },
      extraArgs: ['--expect-error', 'VALIDATION_ERROR'],
    },
  },
  {
    // The read side of the second form model. `FORM_XFA` was documented in `14-SIGN-AND-FORMS.md` §3 with no raise site
    // and no fixture, so this is the first case that can see it — and the mutation silences exactly the sentence the
    // document promised, leaving a correct list of fields and a caller who does not know which model it came from.
    id: 'extract-fields-xfa-warning',
    invariant: 'reading a document that carries an XFA packet says which form model was read',
    regression: 'drop the XFA branch, so the AcroForm mirror is presented as the document’s only form',
    service: 'worker-light',
    path: 'workers/light/src/handlers/extract-fields.ts',
    from: '  if (xfa) {',
    to: '  if (false as boolean) {  // falsify: the packet is never mentioned',
    expect: /expected the job to report FORM_XFA/,
    case: {
      tool: 'extract-fields',
      plan: 'pro',
      files: ['form-xfa-a4.pdf'],
      extraArgs: ['--expect-warning', 'FORM_XFA'],
    },
  },
  {
    // The write side of it, on the same fixture: values go into the AcroForm mirror and the packet is left alone, and a
    // caller whose recipient uses an XFA-aware reader has to hear that. The mutation silences the sentence while every
    // value still lands, which is the shape of a "success" that means two different things in two applications.
    id: 'fill-form-xfa-warning',
    invariant: 'filling a document that carries an XFA packet says the packet was left untouched',
    regression: 'drop the XFA branch, so a fill that an XFA-aware reader may disagree with is reported as ordinary',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/fill-form.ts',
    from: '  if (before.xfa) {',
    to: '  if (false as boolean) {  // falsify: the packet is never mentioned',
    expect: /expected the job to report FORM_XFA/,
    case: {
      tool: 'fill-form',
      plan: 'pro',
      files: ['form-xfa-a4.pdf'],
      options: { fields: { employee_name: 'Boni Pratama' }, flatten: false },
      extraArgs: ['--expect-warning', 'FORM_XFA'],
    },
  },
  {
    // A value longer than the field's own `/MaxLen`. The engine skips the field and the handler names it; the mutation
    // writes the value anyway — which is what "truncate it silently" looks like from outside, and the assertion that
    // catches it is the *absence*: 120 characters were sent, so any run of `x`s on the page is the value that should
    // not be there. The first version of this behaviour truncated, and no case could have seen it before this one.
    id: 'fill-form-maxlen-skip',
    invariant: 'a value longer than the field allows is skipped and named rather than written truncated',
    regression: 'remove the maxLength branch, so an over-long value is written into the field whole',
    service: 'worker-heavy',
    path: 'packages/engines/src/forms.ts',
    from: '                if max_len is not None and len(text) > int(max_len):',
    to: '                if False:  # falsify: the value is written whatever the field allows',
    expect: /which it should not/,
    case: {
      tool: 'fill-form',
      plan: 'pro',
      files: ['form-five-fields-a4.pdf'],
      options: { fields: { employee_name: 'x'.repeat(120), acknowledged: true }, flatten: false },
      extraArgs: ['--expect-absent-text', 'xx'],
    },
  },
  {
    // `sign`'s honesty claim is a **difference**, not an absolute: this tool may add no signature dictionary, and the
    // document it is handed may already carry one. The mutation is the pre-fix comparison — output against zero — which
    // makes the ordinary case fail: a form with an empty signature placeholder is a document "carrying signature
    // vocabulary" and no signature, and signing it is what the tool is for. Measured before the fix, which is why the
    // case exists; the failure it produces names the job, not the guard, because the guard's product is a refused job.
    id: 'sign-placeholder-not-a-signature',
    invariant: 'signing a document with an unfilled signature field is an ordinary job, not a refused one',
    regression: 'compare the output against zero instead of against the input, so a placeholder refuses the job',
    service: 'worker-heavy',
    path: 'workers/heavy/src/handlers/sign.ts',
    from: '  if (addedObjects > 0 || addedValues > 0 || addedByteRange || addedPerms) {',
    to: '  if (record.signatureObjects > 0 || record.signatureValues > 0 || record.byteRange || record.perms) {  // falsify',
    expect: /the job ended as FAILED/,
    case: {
      tool: 'sign',
      plan: 'pro',
      files: ['form-five-fields-a4.pdf'],
      options: {
        kind: 'typed',
        signature: 'Boni Pratama',
        fields: [{ page: 1, x: 72, y: 470, w: 168, h: 24, units: 'pt' }],
        showDateStamp: false,
      },
    },
  },
  {
    // The contract's freehand cap, which is a number in a table (`13-EDIT-AND-ANNOTATE.md` §6: "5 000 per element") and
    // the only bound on a single option value — every point becomes a PostScript path segment. The mutation lowers the
    // cap by one, which is invisible to every case except the strict edge: 5 000 points is legal, so the case that
    // sends exactly 5 000 has to be accepted, and under the mutation it is refused at the door.
    id: 'freehand-cap-exact',
    invariant: '5 000 freehand points is the largest stroke a job may carry, and 5 000 is allowed',
    regression: 'lower the documented cap by one, so the strict edge the document names is refused',
    service: 'api',
    path: 'packages/contracts/src/tools/options.ts',
    // The mutation targets the `.max(...)` line alone, spelled as the formatter leaves it: the first version of this
    // claim quoted the whole assignment on one line, and the runner refused it as stale rather than patching nothing —
    // "the claim is stale" being the message a claim whose target moved is supposed to produce.
    from: '      .max(FREEHAND_POINTS_MAX),',
    to: '      .max(FREEHAND_POINTS_MAX - 1),  // falsify: one point under the documented cap',
    expect: /creating the job returned/,
    case: {
      tool: 'edit-pdf',
      plan: 'pro',
      files: ['pages-six-a4.pdf'],
      options: {
        elements: [
          {
            type: 'draw',
            page: 1,
            strokeWidth: 2,
            points: Array.from({ length: 5000 }, (_, index) => ({
              x: 100 + ((index * 7) % 300),
              y: 400 + ((index * 11) % 100),
            })),
          },
        ],
      },
    },
  },
  {
    // `countFrom` has two halves — which page shows "1", and which pages are stamped at all — and the document's own
    // rule is that a page before the base does not carry one of its numbers. The mutation drops the *second* half,
    // which is the half no text assertion can see: numbering every page of the fixture still ends at "10 of 10", so
    // the case would pass on its text alone. It is the counts the claim leans on, and the mutation moves both.
    id: 'page-numbers-countfrom-excludes',
    invariant: 'pages before `countFrom` carry no number, and the metrics count only the pages that do',
    regression: 'stop excluding the pages before `countFrom`, so front matter is numbered after all',
    service: 'worker-light',
    path: 'workers/light/src/handlers/page-numbers.ts',
    from: '  return unique.filter((page) => (!skipFirstPage || page !== 1) && (countFrom == null || page >= countFrom));',
    to: '  return unique.filter((page) => !skipFirstPage || page !== 1);',
    expect: /metrics\.pagesStamped is/,
    case: {
      tool: 'page-numbers',
      files: ['cover-toc-body-a4.pdf'],
      options: { format: 'n-of-total', countFrom: 3, startAt: 1 },
      extraArgs: ['--expect-metric', 'pagesStamped=10', '--expect-metric', 'firstStampedPage=3'],
    },
  },
  {
    // `skipFirstPage` is the same rule asked about page one, and its case proves the absence by *text*: with the
    // option honoured "Page 1 of 6" cannot appear anywhere, because the document is renumbered from page two and
    // `{total}` follows. The mutation keeps the flag in the signature and ignores it in the filter, which is exactly
    // how the option was dead before this pass — the schema accepted it and no page list moved.
    id: 'page-numbers-skip-first-page',
    invariant: 'the first page carries no stamp at all when `skipFirstPage` is set',
    regression: 'accept `skipFirstPage` and stamp page one anyway',
    service: 'worker-light',
    path: 'workers/light/src/handlers/page-numbers.ts',
    from: '  return unique.filter((page) => (!skipFirstPage || page !== 1) && (countFrom == null || page >= countFrom));',
    to: '  return unique.filter((page) => countFrom == null || page >= countFrom);',
    expect: /which it should not/,
    case: {
      tool: 'page-numbers',
      files: ['pages-six-a4.pdf'],
      options: { format: 'page-n-of-total', skipFirstPage: true },
      // The absence flag alone: naming the text it must print as well would let the *presence* check fail first, and the
      // claim would then be a statement about an assertion that never ran (the lesson the OCR claims learned).
      extraArgs: ['--expect-absent-text', 'Page 1 of 6'],
    },
  },
  {
    // Bates `digits` is a minimum width, and the natural wrong implementation is the one that reads like a format
    // string: `slice(-digits)`. A discovery set numbered INV999, INV000, INV001 looks right at a glance and repeats
    // numbers, so the case asserts the *last* number of the run — 1004 needed four digits and got them.
    id: 'page-numbers-bates-digits-are-a-minimum',
    invariant: 'a Bates number that outgrows `digits` gets wider rather than wrapping',
    regression: 'truncate the number to `digits` characters instead of padding it',
    service: 'worker-light',
    path: 'workers/light/src/handlers/page-numbers.ts',
    from: "  return `${bates.prefix}${String(number).padStart(bates.digits, '0')}${bates.suffix}`;",
    to: '  return `${bates.prefix}${String(number).slice(-bates.digits)}${bates.suffix}`;',
    expect: /does not contain/,
    case: {
      tool: 'page-numbers',
      files: ['pages-six-a4.pdf'],
      options: { bates: { prefix: 'INV', digits: 3, startAt: 999 } },
      extraArgs: ['--expect-text', 'INV1004'],
    },
  },
  {
    // The probe that warns about a document arriving pre-numbered reads **word boxes inside the stamp's own band**, and
    // the band test is the whole of it. Removing that test leaves a probe that runs, returns `null` and reports
    // nothing — the shape a *warning* defect takes: no failure, no output, just a doubled number nobody is told about.
    id: 'page-numbers-printed-probe',
    invariant: 'a document already numbered in the stamp’s own band is reported, not silently doubled',
    regression: 'make the band test never match, so the probe reads nothing',
    service: 'worker-light',
    path: 'workers/light/src/handlers/page-numbers.ts',
    from: '    const inside = top ? yMin <= bandPt : yMax >= pageHeightPt - bandPt;',
    to: '    const inside = false;',
    expect: /expected the job to report/,
    case: {
      tool: 'page-numbers',
      files: ['numbered-invoices-a4.pdf'],
      options: { format: 'page-n-of-total' },
      extraArgs: ['--expect-warning', 'NUMBERING_ALREADY_PRESENT'],
    },
  },
  {
    // `differentFirstPage` replaces page one's bands. The first mutation is the one a reader would write if they had
    // only the option's name: keep it in the schema, never look at it — page one then carries the document's own
    // header, which the case notices as the *absence* of the override's words.
    id: 'header-footer-first-page-band',
    invariant: 'page one carries the `differentFirstPage` band instead of the document’s own one',
    regression: 'read the option and then ignore it, so page one keeps the ordinary header',
    service: 'worker-light',
    path: 'workers/light/src/handlers/header-footer.ts',
    from: '  const alternate = options.differentFirstPage ?? null;',
    to: "  const alternate: HeaderFooterOptions['differentFirstPage'] = null;",
    expect: /does not contain/,
    case: {
      tool: 'header-footer',
      files: ['pages-six-a4.pdf'],
      options: {
        header: { center: 'Body page {page}' },
        differentFirstPage: { header: { left: 'Cover sheet - internal use' } },
      },
      extraArgs: ['--expect-text', 'Cover sheet - internal use'],
    },
  },
  {
    // The second mutation is the one an *over-eager* implementation writes: apply the override everywhere. Page one is
    // still right, every assertion about the cover sheet still passes, and only the ordinary band's own page variable
    // goes missing — checked in the output's objects rather than in the metrics, because the metrics are the handler's
    // claim about itself.
    id: 'header-footer-first-page-only',
    invariant: 'the `differentFirstPage` band is confined to page one',
    regression: 'apply the first-page override to every page',
    service: 'worker-light',
    path: 'workers/light/src/handlers/header-footer.ts',
    from: '    if (!alternateApplies || pageNumber !== 1) return mainBands;',
    to: '    if (!alternateApplies) return mainBands;',
    expect: /is missing from the output/,
    case: {
      tool: 'header-footer',
      files: ['pages-six-a4.pdf'],
      options: {
        header: { center: 'Body page {page}' },
        differentFirstPage: { header: { left: 'Cover sheet - internal use' } },
      },
      extraArgs: ['--expect-bytes', 'Body page 6'],
    },
  },
  {
    // The logo's opacity is one argument on the second merge, and dropping it is invisible to every other assertion: the
    // page count, the `/SMask` and the header text are all unchanged by a logo that is too dark. The ExtGState name is
    // the merge module's own (`/GSwm`), so this also refuses a build that attenuates the whole page to fade a logo.
    id: 'header-footer-logo-opacity',
    invariant: 'a logo’s opacity reaches the file as a constant-alpha graphics state',
    regression: 'merge the logo at full strength, ignoring `logoOpacity`',
    service: 'worker-light',
    path: 'workers/light/src/handlers/header-footer.ts',
    from: '      alpha: options.logoOpacity,',
    to: '      alpha: 1,',
    expect: /is missing from the output/,
    case: {
      tool: 'header-footer',
      files: ['pages-six-a4.pdf'],
      options: {
        header: { center: 'Rumindium' },
        logoHeightMm: 8,
        logoOpacity: 0.4,
        logoFileId: `@upload:${join(FIXTURE_DIR, 'watermark-logo.png')}`,
      },
      extraArgs: ['--expect-bytes', '/GSwm'],
    },
  },
  {
    // `watermark`'s first claims, and the option the document has published since it was written while the schema
    // refused the key. The mutation is the exact shape the option had before this pass — accepted, never read — and the
    // case catches it twice over; the metric is what fires first, which is why the claim names that assertion rather
    // than the absence of the stamp. A reader who only saw "a page-one stamp is missing" could not tell a dropped
    // page from a dropped flag.
    id: 'watermark-skip-first-page',
    invariant: '`skipFirstPage` removes page one from the selection, and the counts say so',
    regression: 'accept `skipFirstPage` and stamp every page anyway',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: '  return skipFirstPage ? unique.filter((page) => page !== 1) : unique;',
    to: '  return unique;',
    expect: /metrics\.pagesStamped is/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: { kind: 'text', text: 'MARK {page}/{total}', rotation: 0, skipFirstPage: true },
      extraArgs: [
        '--expect-metric',
        'pagesStamped=5',
        '--expect-metric',
        'firstStampedPage=2',
        '--expect-absent-text',
        'MARK 1/6',
      ],
    },
  },
  {
    // The other half of the same rule from the other side: `{total}` is the *document's* page count, not the number of
    // pages a job stamped. Both cases read "MARK 6/6", so the two implementations differ only in which number they
    // print — and a build that numbers the stamped pages instead leaves page eight of a filtered job saying "1 of 4".
    id: 'watermark-total-is-the-document',
    invariant: '`{total}` counts the pages of the output, not the pages the job stamped',
    regression: 'resolve `{total}` from the stamped page list',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: "      if (variable === 'total') return String(documentPages);",
    to: "      if (variable === 'total') return String(plan.length);",
    expect: /does not contain/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: { kind: 'text', text: 'MARK {page}/{total}', rotation: 0, skipFirstPage: true },
      extraArgs: ['--expect-text', 'MARK 6/6'],
    },
  },
  {
    // A token the build cannot fill. The natural wrong implementation is the *helpful* one — treat every `{word}` as a
    // variable and put something plausible there — which is why this mutation widens the substitution regex rather
    // than deleting it: the stamp still renders, the warning still fires (it is computed from a different pattern), and
    // only the literal text in the output is wrong. That is the failure a reader would never notice on a 400-page run.
    id: 'watermark-unknown-token-is-literal',
    invariant: 'a `{token}` this build cannot resolve is printed verbatim rather than filled with a plausible value',
    regression: 'treat every `{word}` as a variable and substitute the date for the unknown ones',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: '/\\{(page|total|date)\\}/g;',
    to: '/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g;',
    expect: /does not contain/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: { kind: 'text', text: 'CONFIDENTIAL {user}', rotation: 0 },
      extraArgs: ['--expect-text', '{user}'],
    },
  },
  {
    // The warning itself, proved separately from the metric that describes it: the case asserts the code and the metric
    // both, so mutating only the code leaves the metric correct and the warning missing. Without this claim the
    // UNKNOWN_VARIABLE assertion would be the one an implementation could satisfy by *not* printing the token at all.
    id: 'watermark-unknown-token-warns',
    invariant: 'an unresolvable token is named in a warning rather than silently skipped',
    regression: 'compute the unresolved tokens but report a different warning code',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: "      code: 'UNKNOWN_VARIABLE',",
    to: "      code: 'TEXT_TRUNCATED',",
    expect: /expected the job to report/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: { kind: 'text', text: 'CONFIDENTIAL {user}', rotation: 0 },
      extraArgs: ['--expect-metric', 'unresolvedVariables=["user"]', '--expect-warning', 'UNKNOWN_VARIABLE'],
    },
  },
  {
    // The image watermark's downsample cap, mutated at the one call that names it: the cap is off by default in the
    // engine precisely so a caller can be wrong about it, which is what makes this mutation the realistic one. The
    // metric fails rather than the warning, and the difference matters — a build that resized without saying so and one
    // that never resized are the same absence in the warnings list.
    id: 'watermark-image-downsample',
    invariant: 'an image above the downsample cap is reduced, and the job reports both sizes',
    regression: 'stop passing the downsample cap, so the bitmap is embedded at whatever size it arrived',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: '    { downsampleAbovePx: WATERMARK_IMAGE_DOWNSAMPLE_PX },',
    to: '    {},',
    expect: /metrics\.imageWidth is/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: {
        kind: 'image',
        scalePercent: 40,
        rotation: 0,
        position: 'center',
        imageFileId: `@upload:${join(FIXTURE_DIR, 'watermark-logo-large.png')}`,
      },
      extraArgs: ['--expect-metric', 'imageWidth=4000', '--expect-warning', 'IMAGE_LARGE'],
    },
  },
  {
    // The refusal cap measured against the **source**. Checking the placed dimensions instead is the defect this case
    // was written for, and it is invisible from the outside: every other watermark case in the suite stays green, the
    // job succeeds, and a 12 000 px bitmap goes into the document. The verdict has to come from the *refusal*, so the
    // claim expects the run that completes when it should not have.
    id: 'watermark-image-refusal-reads-the-source',
    invariant: 'an oversized bitmap is refused on the dimensions the file arrived with',
    regression: 'check the placed dimensions instead of the source ones, so the cap never fires',
    service: 'worker-light',
    path: 'workers/light/src/handlers/watermark.ts',
    from: '  if (built.sourceWidth > WATERMARK_IMAGE_MAX_PX || built.sourceHeight > WATERMARK_IMAGE_MAX_PX) {',
    to: '  if (built.imageWidth > WATERMARK_IMAGE_MAX_PX || built.imageHeight > WATERMARK_IMAGE_MAX_PX) {',
    expect: /but it completed/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: {
        kind: 'image',
        scalePercent: 40,
        rotation: 0,
        position: 'center',
        imageFileId: `@upload:${join(FIXTURE_DIR, 'watermark-logo-huge.png')}`,
      },
      extraArgs: ['--expect-error', 'VALIDATION_ERROR'],
    },
  },
  {
    // The tile grid, mutated where the arithmetic lives: the plausible regression is not "no tiling" but "tile anyway,
    // ignoring the gap the caller chose", which is the default's own value and looks correct on a page. The case is
    // written at the *minimum* gap the schema allows (10 %), because that is where the number means something —
    // `round(100 / 10)` is 100 stamps per page, and the whole reason the gap range exists is to bound it.
    //
    // The range itself gets no claim, and the reason is worth recording: it is enforced twice (the API validates the
    // request, the worker validates the queued options), so widening one copy leaves the case refused by the other and
    // the mutation is invisible — a single-site claim cannot falsify a two-layer bound. The refusal case in the golden
    // suite still asserts the behaviour; this claim guards the arithmetic the bound is protecting.
    id: 'watermark-tile-grid',
    invariant: 'the tile grid follows the caller’s gap, so the published minimum gap really is 100 stamps a page',
    regression: 'lay out a fixed grid from the default gap and ignore the caller’s spacing',
    service: 'worker-light',
    path: 'packages/engines/src/overlay.ts',
    from: '  const columns = Math.max(1, Math.round(100 / gapXPercent));\n  const rows = Math.max(1, Math.round(100 / gapYPercent));',
    to: '  const columns = Math.max(1, Math.round(100 / WATERMARK_TILE_DEFAULT_PERCENT));\n  const rows = Math.max(1, Math.round(100 / WATERMARK_TILE_DEFAULT_PERCENT));',
    expect: /metrics\.stampsPerPage is/,
    case: {
      tool: 'watermark',
      files: ['pages-six-a4.pdf'],
      options: { kind: 'text', text: 'DRAFT', position: 'tile', tile: { x: 10, y: 10 }, rotation: 0 },
      extraArgs: ['--expect-metric', 'stampsPerPage=100'],
    },
  },

  // ─── The served bundle: the claims only a browser can read ─────────────────
  //
  // Every claim above patches a source file a container runs, and the container is where the patch is read from. These
  // five patch the **built bundle nginx serves**, because that is the only place the corrections they are about exist:
  // the studio's panel clamp and its stylesheet (`e2e/browser/edit-pdf.e2e.ts`, claims 17–20). `Dockerfile.web` builds
  // the bundle, so no file in the checkout is the bytes under test, and the `web` image's runtime layer holds nginx and
  // the built `dist` — which is what made these five `sed`s inside a running container, run by hand, in passes 73, 74
  // and 75. This is the stage they were owed: read the asset out, patch it where nginx will serve it, run the one case
  // that owns the assertion, put the bytes back and compare the digest — no build, no restart, seconds per claim.
  //
  // Their `from` fields are **patterns**, and the bytes are minified: `Me=V=>Math.min(O,V)` is one bundler's naming for
  // "the shorter of the panel and the room it was given", and it changes the day anything else in the chunk is edited.
  // Each pattern is written as the shape the code has, so what it names is the behaviour. The assertions in the case
  // carry matching **messages** for the same reason, and it is the verdict's evidence: `expect(value, 'a panel with no
  // room on either side is shortened')` fails with that sentence, and a claim that quoted a line number instead would
  // go stale the day a comment was added above it.
  {
    // The clamp's region: the window cut down by every ancestor that clips. Removing the walk is the regression that
    // looks most like a simplification — the window is *a* box the panel has to fit in — and it is invisible to every
    // reading that asks about the window, which is why the case that catches it is the column at 900 × 900.
    id: 'panel-clip-region',
    invariant: 'the ⓘ panel is placed inside the box that clips it, not only inside the window',
    regression: 'treat every ancestor as if it clipped nothing, so the region is the window again',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.js',
    needsBrowser: true,
    from: /if\((\w+)\.overflowX!=="visible"\|\|\1\.overflowY!=="visible"\)/,
    to: 'if(!1)',
    expect: /the panel is placed inside the column that clips it/,
    case: { browser: { file: 'e2e/browser/edit-pdf.e2e.ts', grep: 'the toolbox arrives' } },
  },
  {
    // The re-derivation, and the mutation is the one pass 74 falsified by hand: without the listener an open panel keeps
    // the correction it was opened with while the box it was measured against scrolls away underneath it — 30 px of it
    // through the column after one wheel turn, and the trigger itself out of the box after the next.
    id: 'panel-scroll-rederives',
    invariant: 'the ⓘ panel is re-derived whenever the page or the box that clips it scrolls',
    regression: 'never register the scroll listener, so an open panel keeps a correction for a box that moved',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.js',
    needsBrowser: true,
    from: /window\.addEventListener\("scroll",\w+,\{capture:!0,passive:!0\}\)/,
    to: 'void 0',
    expect: /the disclosure goes with its trigger when the page scrolls past it/,
    case: { browser: { file: 'e2e/browser/edit-pdf.e2e.ts', grep: 'the toolbox arrives' } },
  },
  {
    // The cap: what made a window too short for the panel end with the panel over the button that opened it. The
    // regression hands the clamp back its own height, which is exactly the code pass 75 replaced.
    id: 'panel-cap-shortens',
    invariant: 'a panel with no room on either side is shortened rather than drawn over its trigger',
    regression: 'cap the panel at its own height, which is the old slide that covered the trigger',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.js',
    needsBrowser: true,
    from: /(\w+)=(\w+)=>Math\.min\((\w+),\2\)/,
    to: '$1=()=>$3',
    expect: /the panel stays inside the window it was measured for/,
    case: { browser: { file: 'e2e/browser/edit-pdf.e2e.ts', grep: 'the text is typed' } },
  },
  {
    // The floor, mutated at the three constants that sit together in the built chunk: 16, 8 and 72 are the panel's
    // margin, its gap and the height of its own chrome plus one fact. Raising the third is the regression that says
    // "never shorten, always slide", and the case owes a red reading on the cap's own measurement.
    id: 'panel-cap-floor',
    invariant: 'shortening stops at the panel’s own first fact, and a sliver below that is never drawn',
    regression: 'raise the floor to 300 px, so no side is ever worth shortening for',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.js',
    needsBrowser: true,
    from: /(\w+)=16,(\w+)=8,(\w+)=72/,
    to: '$1=16,$2=8,$3=300',
    expect: /a panel with no room on either side is shortened/,
    case: { browser: { file: 'e2e/browser/edit-pdf.e2e.ts', grep: 'the text is typed' } },
  },
  {
    // The other half of the cap, and the only claim here whose subject is the **stylesheet**: a panel shortened to the
    // room its side has is only honest if the facts behind the fold can be reached. Without `overflow-y` the box still
    // shrinks — the height is not what the claim is about — and its content is cut instead, which no box reading sees.
    id: 'panel-cap-scrolls',
    invariant: 'the facts behind a shortened panel are reachable by scrolling it',
    regression: "drop the panel's own `overflow-y`, so a capped panel cuts its content instead of scrolling it",
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.css',
    needsBrowser: true,
    from: 'max-width:calc(100vw - 32px);overflow-y:auto;padding:14px',
    to: 'max-width:calc(100vw - 32px);padding:14px',
    expect: /the facts behind the cap are reachable/,
    case: { browser: { file: 'e2e/browser/edit-pdf.e2e.ts', grep: 'the text is typed' } },
  },

  {
    // The order board's stacked layout, and the mutation pass 54 ran by hand: the rule that gives the document one band
    // and the arrangement the whole width under it, set back to the two columns it replaced. The reading that owns it is
    // the board's own grid and its cards' boxes rather than a class name, which is deliberate — defect 236 was exactly
    // this rule served correctly to a tab that drew the old columns anyway, and the case was rewritten to measure
    // rendered boxes for that reason (and to read *layout* boxes, because an entry animation makes a rect a scaled box,
    // defect 237). The rule is shared with the crop board, so the mutation un-stacks that board too; the order board's
    // case is the one that owns this claim because it is the board whose product is the row.
    id: 'reorder-stacked-is-one-track',
    invariant: 'the order board is a single column, so its row of tiles is one row',
    regression: 'give the stacked board the two columns it was stacked to replace',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.css',
    needsBrowser: true,
    from: '.tool-split-board.tool-stacked,.tool-split-crop.tool-stacked{grid-template-columns:minmax(0,1fr)}',
    to: '.tool-split-board.tool-stacked,.tool-split-crop.tool-stacked{grid-template-columns:minmax(0,1fr) minmax(0,1.7fr)}',
    expect: /the two cards are stacked rather than side by side/,
    case: { browser: { file: 'e2e/browser/reorder-pages.e2e.ts', grep: 'the tiles are the form' } },
  },
  {
    // The sheet `n-up` draws, whose geometry is what its five options are about. Every number inside the drawing is a
    // percentage of this element, so a paper that is not the stock's aspect ratio puts every cell somewhere the drawing
    // does not promise while the cell *count* stays right — the class of defect this board's case is written against.
    // The mutation removes the declaration that says so, which reads like a redundancy in the rule: the paper keeps its
    // width (`min(100%, 760px, …)`) and loses its height, because a box with `position: relative` and absolute children
    // has no content to derive one from.
    id: 'nup-sheet-keeps-stock-ratio',
    invariant: 'the sheet is drawn at the aspect ratio of the stock the options name',
    regression: 'drop the paper\u2019s `aspect-ratio`, so its shape is whatever its content leaves it',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/index-*.css',
    needsBrowser: true,
    from: 'aspect-ratio:var(--sheet-ratio)',
    to: 'aspect-ratio:auto',
    expect: /the sheet is drawn at the ratio of the stock it names/,
    case: { browser: { file: 'e2e/browser/n-up.e2e.ts', grep: 'the sheet is drawn' } },
  },

  {
    // The sheet's division, and the first claim here whose subject is in a **route chunk** rather than the shared one: the
    // board's arithmetic is code-split with the tool, so the glob is the tool route's own family and the line decides which
    // file in it — the same rule the panel claims follow, applied one level up.
    //
    // `Sa=10,Ta=15,Xn=25.4/72` is what the bundler made of the two sheet margins and the millimetres-per-point conversion
    // beside them; the pattern names that *shape* (two constants 10 and 15 followed by the conversion), because the letters
    // are the bundler's. Zeroing both is the grid dividing the paper for itself: the cells grow and the first one starts
    // at the paper's own edge, which is exactly what a screen that forgot the engine's margins would draw.
    //
    // The reading that owns it sits **before** the caption assertions in the case, and that order is deliberate rather than
    // incidental: the captions are computed from the same two constants, so under this mutation they move too, and a case
    // that read them first would fail on a sentence about words instead of on the geometry this claim is about.
    id: 'nup-grid-divides-where-the-handler-says',
    invariant:
      "the drawn grid divides the sheet by the handler's margins, gap and cell rule, not only into the right number of cells",
    regression: 'give both sheet margins the value zero, so the grid starts at the paper’s own edge',
    service: 'web',
    mutate: 'served-asset',
    asset: '/usr/share/nginx/html/assets/tools.*.js',
    needsBrowser: true,
    from: /(\w+)=10,(\w+)=15,(\w+)=25\.4\/72/,
    to: '$1=0,$2=0,$3=25.4/72',
    expect: /the drawn grid is the handler’s division of the sheet/,
    case: { browser: { file: 'e2e/browser/n-up.e2e.ts', grep: 'the sheet is drawn' } },
  },

  // ─── The claims whose regression is in a component, so a build is the only road ──
  //
  // The five above patch what nginx already serves, which is the cheap road and works because their corrections live in
  // CSS or in built JavaScript. A correction that lives in a **React component** is not in the bundle until the image is
  // built, so that claim pays `mutate: 'checkout'`: the source is patched in the checkout, `web` is rebuilt, and the
  // restore writes the bytes back and rebuilds again. It is the price the served-asset mode was invented to avoid, and
  // the reason this family is not bigger than the claims that genuinely need it. `needsBrowser` for the same reason as
  // the family above — the case is a browser case — so these run in the CI job that has a `web` container and a browser.
  {
    // The crop board's filmstrip: the tile is a picture of a page with a membership toggle on it, and the **page** it is
    // about is the tile's own number. The board has both in scope while rendering a tile — `number` for the tile and
    // `page` for the page the box is drawn on — and they are the same type, so writing the wrong one compiles, renders
    // and looks right. What it costs is invisible to the count: taking page 1 out instead of page 2 leaves the summary
    // saying `5 of 6 pages`, so every reading that asks *how many* passes and only the ones that ask *which* fail. That
    // is the same shape as this board's oldest defect (a crop that wrote nothing is still a page), and the reason the
    // case asserts the tile's own `data-cropped` and the advanced rows' spelling rather than the sentence. The mutation
    // happens to be a no-op if the board is drawing the page that was clicked, and the verdict for that is
    // `not-falsified` — loud, which is the only acceptable way for a claim to be measuring nothing.
    id: 'crop-strip-toggle-names-its-page',
    invariant: "a click in the crop board's filmstrip takes the page it was clicked on out of the crop",
    regression:
      'toggle the page the board is showing instead of the tile that was clicked, which leaves the count right and the set wrong',
    service: 'web',
    path: 'apps/web/src/features/page-crop/index.tsx',
    from: 'toggleCroppedPage({ value: values.pages, page: number, pageCount: count })',
    to: 'toggleCroppedPage({ value: values.pages, page, pageCount: count })',
    expect: /the tile that was clicked is the page that leaves the crop/,
    mutate: 'checkout',
    needsBrowser: true,
    case: { browser: { file: 'e2e/browser/crop.e2e.ts', grep: 'a box drawn on the page' } },
  },

  // ─── Strict mode: the third position, and the four defects it cost ──────────
  //
  // These claims are last because they are the only ones that change the *stack position*: each one needs a platform
  // that answers `strictMode: true`, and the group is entered once and left once so no other claim is ever measured
  // against a stack that serves nobody. They are also the only claims whose regression was **shipped** — every other
  // claim here is a sabotage of code that works. Four of the five were found by looking at the page rather than by
  // reading the code, which is why two of them are browser cases: nothing in this repository could fail for the shape
  // of what a visitor is shown.
  {
    // The edge. `onBeforeHandle` inside a plugin is `local` by default, and a local hook reaches nothing in the
    // parent that `use`d it — so the guard was written, registered, reviewed, and covered no route at all. Every unit
    // test of the policy stayed green, because the policy was never the broken part.
    //
    // The case is the strict leg of the tenant-first stage, and the failure it owes is the *catalogue*: the door
    // (`/me`, `/sso/*`) must keep answering, so a claim that expected "everything is refused" would be satisfied by an
    // installation nobody can enter.
    id: 'strict-edge-scope',
    invariant: 'with strict mode on, a caller with no account is refused the catalogue, the uploads and the job list',
    regression: "drop the hook's `as: 'scoped'`, so it guards no route at all — the default and the shipped defect",
    service: 'api',
    path: 'apps/api/src/plugins/strict-surface.ts',
    from: "    { as: 'scoped' },",
    to: '    {},',
    expect: /GET \/tools answered 200/,
    position: 'strict',
    case: { stage: 'tenant-first' },
  },
  {
    // The welcome itself, and the behaviour this pass replaced: a card with a button on an installation that has no
    // page for the visitor to press it from. The regression is the *whole* decision being absent, written as the line
    // that builds the address, because a claim that broke one of the guards instead would be measuring the guard while
    // the trip it protects still happened — and the guards are exactly what a later reader is tempted to "simplify".
    //
    // The case is the browser's first test, whose failure names what is owed: a strict installation walks the visitor
    // to the workspace rather than leaving them on a card. The card is still asserted, by the second test in the same
    // file, in the state the trip leaves behind — so this claim and the three below it measure opposite ends of one
    // decision from one report.
    id: 'strict-visitor-is-walked-to-sign-in',
    invariant:
      'a visitor with no account on a strict installation is sent to the workspace sign-in page, not left on a card',
    regression: 'answer with a card: never build the sign-in address, so the trip never happens',
    service: 'web',
    path: 'apps/web/src/features/sign-in-gate/gate.ts',
    from: '  return signInHref(me, withRelinkParam(currentUrl));',
    to: '  return null;',
    expect: /must be walked to the sign-in page/,
    position: 'strict',
    mutate: 'checkout',
    case: { stage: 'strict-gate' },
  },
  {
    // The shell, half one: the identity and the catalogue were one `Promise.all`, so a *policy* refusal of the
    // catalogue — expected, on this installation — discarded the identity the gate is built from. The page then
    // showed an outage and no way in.
    //
    // The regression is the smaller of the two lines that defect touched, and it is the one the browser case's first
    // assertion names: a refusal reported as a fault.
    id: 'strict-refusal-is-not-an-outage',
    invariant: 'a catalogue refused by policy is not reported to the visitor as an outage',
    regression: 'treat `AUTH_REQUIRED` from the catalogue as a failure of the request',
    service: 'web',
    path: 'apps/web/src/lib/session-load.ts',
    from: "    error: meError ?? (catalogError?.code === 'AUTH_REQUIRED' ? null : catalogError),",
    to: '    error: meError ?? catalogError,',
    expect: /must not be reported as an outage/,
    position: 'strict',
    mutate: 'checkout',
    case: { stage: 'strict-gate' },
  },
  {
    // The shell, half two: the identity itself. Written as the line that decides it, because the defect is a *shape*
    // — "if one of the two calls failed, there is nobody" — and not a misread of either answer.
    id: 'strict-identity-survives-a-refusal',
    invariant: 'the identity survives a refused catalogue, because the gate is rendered from it',
    regression: 'discard the identity whenever the catalogue is not readable',
    service: 'web',
    path: 'apps/web/src/lib/session-load.ts',
    from: "    me: me.status === 'fulfilled' ? me.value : null,",
    to: '    me: null,',
    expect: /the identity must survive a refused catalogue/,
    position: 'strict',
    mutate: 'checkout',
    case: { stage: 'strict-gate' },
  },
  {
    // The gate card's own condition, and the defect that rendered an **empty box**: `root-layout` replaced the page
    // correctly, and the card it replaced it with asked the creation question — which answers "no" for an anonymous
    // session. That is why this claim needs the session captured before the position changes: a guest is caught by the
    // creation question already, so only a cookie minted while anonymous use was on can tell the two predicates apart.
    id: 'strict-gate-asks-both-questions',
    invariant: 'an anonymous session on a strict installation gets the gate card, not an empty page',
    regression: 'ask only the creation question when deciding whether to render the gate',
    service: 'web',
    path: 'apps/web/src/features/sign-in-gate/gate.ts',
    from: "  return gateApplies(me) || strictGateApplies(me) || state?.phase === 'linked';",
    to: "  return gateApplies(me) || state?.phase === 'linked';",
    expect: /the gate card must render for a visitor who holds a session this installation refuses/,
    position: 'strict',
    mutate: 'checkout',
    needsAnonymousSession: true,
    case: { stage: 'strict-gate' },
  },
];

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const base = argValue('--base') ?? 'http://localhost:8080';
const containerRoot = argValue('--container-root') ?? '/app';
/**
 * The claim ids `--only` asked for, or every claim.
 *
 * A list rather than one id, because the strict claims are a *group*: each changes the stack's position, and the
 * position is entered once and left once per invocation (`main`). Five invocations would switch profiles five times
 * and — worse — leave four windows in which a claim could be measured against the profile the previous one left
 * behind. Comma-separated, so the single-id form the docs use keeps working.
 */
const only = argValue('--only');
const wanted = only
  ?.split(',')
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
/**
 * The two halves of the stage, as the CLI spells them.
 *
 * A flag rather than a list of ids in each CI job's command, because the split is a property of the **claim** (`needsBrowser`)
 * and a list of ids is a copy of it that goes stale: a sixth served-asset claim would be run by neither job — the browser
 * job would not name it and the falsify job's stack cannot measure it — and the stage would report a pass over a family it
 * never ran. Both flags are exclusive, and each one refuses to select nothing.
 */
const needsBrowser = argv.includes('--needs-browser');
const withoutBrowser = argv.includes('--without-browser');

interface RunOutcome {
  code: number;
  /** Both streams, for a reader who should not have to know which one carried the reason. */
  output: string;
  /** stdout alone, for the one caller that needs the *last* thing a command said rather than any of it. */
  stdout: string;
}

async function shell(command: string[], env: Record<string, string> = {}, input?: string): Promise<RunOutcome> {
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    // Bytes a caller has to hand over arrive on stdin, never as an argument: a served bundle is 290 KB, and Linux caps a
    // single argument at 128 KB (`MAX_ARG_STRLEN`), so a patch shipped in `argv` dies with `argument list too long` —
    // after the case has already run against a *partly* written file. Every other caller keeps the terminal it had.
    stdin: input === undefined ? 'inherit' : new Blob([input]).stream(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`, stdout };
}

/**
 * Whether the strict position is currently up.
 *
 * Module scope rather than local to `main`, because every container command has to know which side of the switch the
 * stack is on — see `composeArgs` below.
 */
let strictPosition = false;

/**
 * The compose files every container command runs with.
 *
 * The strict group means the *files* are part of the claim's state, not a detail of how it was started: recreating a
 * service from the base file alone while a strict claim is running would hand it back the dev profile's environment —
 * silently, because every command still succeeds — and the next claim in the group would measure a stack that is not in
 * its position and report the harness's own mistake as a product result. So while a strict position is up, every
 * recreate/exec/ps carries the overlay too; `enterStrictPosition` and `leaveStrictPosition` say explicitly which side
 * of the switch they mean, because they are the two commands whose job is to change it.
 */
function composeArgs(args: string[]): string[] {
  return strictPosition ? [...STRICT_COMPOSE, ...args] : ['docker', 'compose', ...args];
}

async function compose(args: string[], input?: string): Promise<RunOutcome> {
  return await shell(composeArgs(args), {}, input);
}

/**
 * Run a statement inside a container.
 *
 * `--user root` for the patch and its verification only, because the images do not agree on who owns their source: the
 * API copies it as root and runs as uid 10001, the light worker owns its own copy as 10001. The patch is a stand-in for
 * a code change, so writing it as root changes nothing about what the case then measures — the process under test is
 * still the unprivileged one.
 */
async function inContainer(service: string, statement: string, asRoot = false, input?: string): Promise<RunOutcome> {
  const user = asRoot ? ['--user', 'root'] : [];
  return await compose(['exec', '-T', ...user, service, 'sh', '-c', statement], input);
}

async function containerStatus(service: string): Promise<string> {
  const result = await compose(['ps', service, '--format', '{{.Status}}']);
  return result.output.trim();
}

/**
 * Wait until the container reports healthy.
 *
 * Both halves of every claim depend on this: a case run against a container that is still starting fails for a reason
 * that has nothing to do with the regression, and the *restore* has to be complete before the next claim patches a
 * container again — otherwise a claim would be measuring the previous one.
 */
async function waitHealthy(service: string, timeoutMs = 150_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await containerStatus(service)).includes('(healthy)')) return true;
    await Bun.sleep(1_000);
  }
  return false;
}

/**
 * Write the patched file into the container.
 *
 * The bytes are base64-encoded on stdin, not spelled into a `sed` expression: the patch targets real source lines with
 * quotes, braces and indentation, and a shell that has to escape them correctly is exactly the kind of fragile step
 * this script exists to replace. Encoding keeps them literal, and stdin keeps them off the command line — the served
 * bundle is 290 KB, past the 128 KB an argument may be. The size is read back afterwards, so a truncated write is a
 * failure here rather than a confusing case result later.
 */
async function writeIntoContainer(service: string, path: string, content: string): Promise<void> {
  // An absolute path is a **served asset**, which lives where nginx put it rather than under the service's own root.
  const containerPath = path.startsWith('/') ? path : `${containerRoot}/${path}`;
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const written = await inContainer(service, `base64 -d > ${containerPath}`, true, encoded);
  if (written.code !== 0) {
    throw new Error(`could not write ${containerPath} in ${service}: ${written.output.trim()}`);
  }
  const size = await inContainer(service, `wc -c < ${containerPath}`, true);
  const expected = Buffer.byteLength(content, 'utf8');
  if (Number(size.output.trim()) !== expected) {
    throw new Error(`${containerPath} in ${service} is ${size.output.trim()} bytes, not the ${expected} written`);
  }
}

/**
 * Is this container running the built image, or a patch an earlier run left behind?
 *
 * The restore is a `--force-recreate` in the `finally`, which is complete and correct — and unreachable when the
 * process is killed (EOF on a closed terminal, a cancelled CI job, a timeout). The patch then outlives everything
 * short of a recreation: `compose restart` keeps the writable layer, and `compose up -d` will not recreate a
 * container whose **image** never changed, so `compose build` reports success while the old bytes keep running.
 *
 * Measured, because it cost an afternoon: a stale `'/work/'` in `workers/shared/src/runtime.ts` — the `spawn-guard`
 * regression — made every engine spawn in that pool refuse to start, and 42 of the light pool's 116 golden suites
 * failed with `SECRET_IN_ARGV` against a clean checkout. Nothing in that output said "you are running a falsified
 * build", which is the part worth fixing: a wrong result that names its own cause is a minute's work, and one that
 * does not is a hunt through the product for a defect that is not there.
 *
 * The digest is the test, and the image is the reference: a container is supposed to be running the image, so its
 * copy of the file has to equal the checkout's. A file the container cannot read is left alone — that is the case's
 * problem to report, not this check's.
 */
async function assertRunningTheBuiltImage(service: string, path: string, source: string): Promise<void> {
  const digest = await inContainer(service, `sha256sum ${containerRoot}/${path} | cut -d' ' -f1`, true);
  if (digest.code !== 0) return;
  const expected = new Bun.CryptoHasher('sha256').update(source).digest('hex');
  if (digest.output.trim() === expected) return;
  throw new Error(
    `${service} is running a patched ${path}, left behind by an interrupted run — every result from it is suspect:\n` +
      `    docker compose up -d --force-recreate ${service}`,
  );
}

/**
 * The container's copy of a file, as text.
 *
 * For the claims whose subject exists **only in the image**: a served asset has no checkout file that is the thing the
 * browser reads, so the copy under test is the one nginx would hand out, and the copy to restore is the one this reads
 * before the patch touches it.
 */
async function readFromContainer(service: string, path: string): Promise<string> {
  const result = await inContainer(service, `base64 < ${path}`, true);
  if (result.code !== 0) throw new Error(`could not read ${path} in ${service}: ${result.output.trim()}`);
  return Buffer.from(result.stdout, 'base64').toString('utf8');
}

/** The digest of a file in a container, for comparing a restore against the bytes it was supposed to put back. */
async function sha256InContainer(service: string, path: string): Promise<string> {
  const result = await inContainer(service, `sha256sum ${path} | cut -d' ' -f1`, true);
  return result.stdout.trim();
}

/**
 * Which file a `'served-asset'` claim patches: the one file under the glob that **contains the line**.
 *
 * The asset's name is a content hash, so the name cannot say what is inside it — and the answer to "which chunk holds
 * this line" is the bundler's to change. The line is the claim's subject, so the line is what finds the file; the glob
 * only says which part of the served tree is worth reading.
 *
 * Every wrong answer is a finding about the **claim** rather than about the product, and each has to be loud: no
 * candidate at all means the build's output moved, no carrier means the line this claim patches is gone (the same
 * stale-claim reading a source patch gets), and two carriers means the claim cannot say what it broke.
 */
async function resolveServedAsset(
  service: string,
  glob: string,
  from: string | RegExp,
): Promise<{ path: string; bytes: string }> {
  const listed = await inContainer(service, `ls ${glob}`, true);
  const candidates = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (candidates.length === 0) {
    throw new Error(
      `nothing in ${service} matches ${glob}; the build's output moved, so this claim cannot name the asset it patches`,
    );
  }
  const carriers: Array<{ path: string; bytes: string }> = [];
  for (const path of candidates) {
    const bytes = await readFromContainer(service, path);
    if (patchSites(bytes, from) > 0) carriers.push({ path, bytes });
  }
  if (carriers.length !== 1) {
    throw new Error(
      `${carriers.length} of the ${candidates.length} file(s) under ${glob} in ${service} contain the line this claim patches; a served-asset claim has to name exactly one (the invariant moved, or the build split it across chunks)`,
    );
  }
  return carriers[0]!;
}

/** How many places a patch target occurs — the check that keeps a claim from quietly testing nothing. */
function patchSites(source: string, from: string | RegExp): number {
  if (typeof from === 'string') return source.split(from).length - 1;
  const flags = from.flags.includes('g') ? from.flags : `${from.flags}g`;
  return source.match(new RegExp(from.source, flags))?.length ?? 0;
}

/** Run the claim's case the way `test:golden` runs it: the same harness, one fixture, one expectation at a time. */
async function runCase(spec: CaseSpec): Promise<RunOutcome> {
  if ('browser' in spec) {
    const command = [
      'bun',
      'run',
      'playwright',
      'test',
      spec.browser.file,
      '--grep',
      spec.browser.grep,
      '--reporter',
      'line',
    ];
    for (const arg of spec.browser.extraArgs ?? []) command.push(arg);
    const outcome = await shell(command);
    // Same fact as the strict gate's, and the same reason to name it: a missing browser is an environment, not a
    // product defect, and a claim that reported it as a caught regression would be the worst kind of false green.
    if (/Executable doesn't exist|download new browsers/.test(outcome.output)) {
      throw new Error(
        'the browser this case needs is not installed on this machine — Playwright answered "Executable doesn\'t ' +
          'exist" for the Chromium build the pinned runner wants. Point it at the browser that is here ' +
          '(`PLAYWRIGHT_CHANNEL=chrome bun run test:falsify …`) or install the pinned build ' +
          '(`bun run playwright install chromium`); neither is a finding about the product, so this claim reports ' +
          'nothing rather than something.',
      );
    }
    return outcome;
  }

  if ('stage' in spec) {
    // The stages are run the way `package.json` runs them, minus the flags that need a database: a claim about the
    // refusal does not need the row count, and demanding `DATABASE_URL` here would make these claims unrunnable on the
    // machine they are most useful on. The stage prints its database-dependent cases as "not run" and the claim's
    // expectation is unaffected — the line it looks for is produced either way.
    // `bun run playwright`, not `bunx playwright`: the runner has to be the one `package.json` runs, or a red result
    // could be the runner's behaviour rather than the product's — a claim has to falsify the thing the stage runs.
    //
    // What that does not solve is a machine with no browser: `PLAYWRIGHT_CHANNEL=chrome` is how a developer who has
    // Chrome runs this without a 150 MB download (`playwright.config.ts` documents the switch, and both entry points
    // honour it), and the check below turns the missing build into a named fact instead of a green-looking verdict.
    const command =
      spec.stage === 'tenant-first'
        ? ['bun', 'run', 'scripts/ci/tenant-first.ts', '--base', base]
        : ['bun', 'run', 'playwright', 'test', '--config', 'playwright.strict.config.ts'];
    for (const arg of spec.extraArgs ?? []) command.push(arg);
    const outcome = await shell(command, strictSessionCookie ? { PDFTOOLS_SESSION_COOKIE: strictSessionCookie } : {});
    // A browser that is not installed is an environment fact, and the honest output is a claim that says so. Playwright
    // fails at `browserType.launch` with a message about an executable that does not exist, and a verdict of
    // "the case failed" from that is a missing download reported as a product defect.
    if (spec.stage === 'strict-gate' && /Executable doesn't exist|download new browsers/.test(outcome.output)) {
      throw new Error(
        'the browser this case needs is not installed on this machine — Playwright answered "Executable doesn\'t ' +
          'exist" for the Chromium build the pinned runner wants. Point it at the browser that is here ' +
          '(`PLAYWRIGHT_CHANNEL=chrome bun run test:falsify …`) or install the pinned build ' +
          '(`bun run playwright install chromium`); neither is a finding about the product, so this claim reports ' +
          'nothing rather than something.',
      );
    }
    return outcome;
  }

  const command = ['bun', 'run', 'e2e/tool.e2e.ts', '--base', base, '--tool', spec.tool];
  for (const file of spec.files) command.push('--file', join(FIXTURE_DIR, file));
  if (spec.options) command.push('--options', JSON.stringify(spec.options));
  if (spec.plan) command.push('--plan', spec.plan);
  for (const arg of spec.extraArgs ?? []) command.push(arg);
  return await shell(command);
}

// ─── The strict position ────────────────────────────────────────────────────

/**
 * The overlay that puts this stack in a position the compose file states.
 *
 * `platform-stub` is the answer to `GET /apps/{code}/public`, and it is deliberately a container the *claim* starts
 * rather than something the developer's environment supplies: a claim whose subject is whatever an operator last
 * clicked in the platform's admin panel is a claim that stops testing the day somebody flips a switch, silently,
 * because both positions boot.
 */
const STRICT_COMPOSE = ['docker', 'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.tenant-first.yml'];

/**
 * Who the stack thinks a caller with no credential is, from the API's own answer.
 *
 * The claim's precondition is asserted this way rather than by the provisioning command's exit code: `compose up`
 * succeeds whether or not the answer changed, and a claim that ran on a stack which was never in its position would
 * report a *pass* (the case fails to see a regression that was never in front of it) or a mystery. The API is asked,
 * because the API is what the case drives.
 */
async function probeMe(): Promise<{ kind?: string; allowAnonymous?: boolean; strictMode?: boolean } | null> {
  try {
    const response = await fetch(`${base}/api/v1/me`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as { kind?: string; strictMode?: boolean };
  } catch {
    return null;
  }
}

/**
 * A session minted **before** the position changes, so the browser cases can hold one in a stack that mints none.
 *
 * This is the half a guest cannot reach. An anonymous cookie keeps resolving after strict mode is turned on — it is a
 * perfectly valid identity that simply may not see the product — and it is the case the page gate could not cover on
 * its own, because such a visitor never loads a page that would ask. The browser case drives it from a cookie handed to
 * the browser, and the cookie is taken here rather than inserted into the database because the *product* is what mints
 * it: a row written by this script would be this script's idea of a session.
 *
 * Two places to take it from, and the second is what makes this runnable on a machine whose app row says strict mode is
 * on — a legitimate position an operator chooses, not an accident to be corrected before the suite is allowed to run:
 *
 *  1. **The dev stack as it stands.** Free when the row serves visitors, and the closest thing to a real visit.
 *  2. **The stub, asked to serve visitors for one request.** The stub is already the authority for the position, so
 *     minting through it is the same product minting a session under a different app row — and the position it is
 *     about to be put back into is strict anyway. Measured on this machine: a strict app row made this claim report
 *     itself `not-falsified` while every ingredient except a visitor was present.
 *
 * Null when neither answered, which is not a failure — the browser claims then run as a guest, and the one that needs
 * an anonymous session reports `not-falsified` loudly instead of passing.
 */
let strictSessionCookie: string | null = null;

/**
 * One attempt to have the **product** mint an anonymous session, waited for rather than assumed.
 *
 * The wait is not politeness: the app mirrors the platform's switches for `APP_ANONYMOUS_CACHE_SECONDS` (60 s by
 * default), so a stack whose row was turned back into service a moment ago still answers `strictMode: true` for up to
 * a minute. Measured: a run that flipped the row and asked 25 s later minted nothing, and the claim that needs a
 * session then reported the *stack's* state as a weak check. Waiting on the answer rather than on the clock is the
 * same discipline `enterStrictPosition` uses.
 */
async function mintAnonymousSession(budgetMs: number): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/v1/me`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const raw = response.headers.getSetCookie?.() ?? [];
      const pair = raw.map((entry) => entry.split(';')[0]).find((entry) => entry?.startsWith('pdft_session='));
      if (pair) return pair;
    } catch {
      // A stack that is mid-recreate answers nothing; the loop is the retry.
    }
    await Bun.sleep(5_000);
  }
  return null;
}

async function captureAnonymousSession(): Promise<void> {
  const direct = await mintAnonymousSession(30_000);
  if (direct) {
    strictSessionCookie = direct;
    console.log(
      '  · position: an anonymous session was minted first, so the cases can hold one in a stack that mints none',
    );
    return;
  }

  // The stack refuses to mint one, so the stub is asked to serve visitors for the single request this needs. `api` goes
  // with it — a fresh container, so the mirror answers the stub rather than a row it had cached — and strict is the next
  // thing that happens to it, in `enterStrictPosition`.
  console.log('  · position: this stack mints no session; asking the stub to serve visitors for one request');
  const up = await shell([...STRICT_COMPOSE, 'up', '-d', '--wait', '--force-recreate', 'platform-stub', 'api'], {
    PLATFORM_STUB_ALLOW_ANONYMOUS: 'true',
  });
  if (up.code !== 0) {
    strictSessionCookie = null;
    console.log(
      `  · position: the stub did not come up, so the browser claims run as a guest:\n${tail(up.output, 4).join('\n')}`,
    );
    return;
  }

  strictSessionCookie = await mintAnonymousSession(90_000);
  console.log(
    strictSessionCookie
      ? '  · position: an anonymous session was minted through the stub, before the position turned strict'
      : '  · position: no session was minted in two minutes — the browser claims run as a guest, and the one that needs an anonymous session reports itself',
  );
}

/**
 * What the dev stack answered about strict mode **before** this run touched it.
 *
 * The check that the position was left behind compared the answer to a literal `false`, which is right on a machine
 * whose stack serves visitors and wrong on one whose app row happens to be strict — the state that made this run's
 * own report say "the dev stack is still reporting strict mode after the position was left" about a stack that was
 * strict before the claim arrived and strict for a reason no claim here can undo. Comparing against the baseline
 * measures the thing the guard is actually for: *this script* must not change what the stack reports. It still
 * catches a claim that left the stub behind, and it lets the group run on a stack whose app row is strict — which is
 * also the position in which the claim that needs an anonymous session reports itself loudly rather than going red.
 */
let strictBaseline: boolean | null = null;

async function enterStrictPosition(): Promise<void> {
  console.log('  · position: strict mode — starting the platform stub and pointing the app at it');
  strictBaseline = (await probeMe())?.strictMode === true;
  await captureAnonymousSession();
  // `--force-recreate` on all three, and the reason is the file's own warning read the other way round: switching
  // profile replaces the **api** container, so it comes back on a different address while nginx inside `web` resolved
  // the old one at startup. Compose does not recreate `web` on its own here (its config is identical in both
  // profiles), so a plain `up` left the SPA proxying to a host that no longer existed — measured on this machine as
  // "Could not reach the API" over a stack whose API was answering correctly the whole time, which is exactly the
  // banner the browser claim is about, produced by the harness instead of the product.
  const up = await shell([...STRICT_COMPOSE, 'up', '-d', '--wait', '--force-recreate', 'platform-stub', 'api', 'web'], {
    PLATFORM_STUB_STRICT_MODE: 'true',
  });
  if (up.code !== 0) {
    throw new Error(`the strict profile did not come up:\n${tail(up.output, 8).join('\n')}`);
  }
  const me = await probeMe();
  if (me?.strictMode !== true || me.allowAnonymous !== false) {
    throw new Error(
      `this claim needs a stack where strict mode is on and answered ${JSON.stringify(me)} — the position was not reached`,
    );
  }
  console.log(`  · position: strict mode is on (kind=${me.kind}, allowAnonymous=false)`);
}

async function leaveStrictPosition(): Promise<void> {
  console.log('  · position: leaving strict mode — back to the dev stack');
  // The stub first, so nothing is left answering for an app the dev stack would then mirror.
  await shell([...STRICT_COMPOSE, 'rm', '-sf', 'platform-stub']);
  await shell(['docker', 'compose', 'up', '-d', '--wait', '--force-recreate', '--no-deps', 'api', 'web']);
  const me = await probeMe();
  // Verified rather than assumed, and the *other* direction is the one that matters: a stack left strict would make
  // every later claim fail for a reason this script injected, which is the worst kind of result to debug. Compared
  // against the answer read before the position was entered rather than against `false` — the guard is about this
  // run's effect on the stack, and a machine whose app row is strict is a position this script never entered.
  if ((me?.strictMode === true) !== strictBaseline) {
    throw new Error(
      `the dev stack reports strictMode=${me?.strictMode === true} after the position was left, where it reported ` +
        `${strictBaseline} before it was entered — the position was not restored`,
    );
  }
  console.log(`  · position: dev stack (strictMode ${strictBaseline === true ? 'still on, as it was' : 'off'})`);
}

/** The line the failure owed, for the artifact and for the reader. */
function matchedLine(output: string, pattern: RegExp): string {
  for (const line of output.split('\n')) {
    if (pattern.test(line)) return line.trim();
  }
  return '';
}

function tail(output: string, lines = 12): string[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
}

interface Verdict {
  id: string;
  invariant: string;
  regression: string;
  status: 'falsified' | 'not-falsified' | 'unexpected-failure' | 'error';
  caseExitCode: number;
  evidence: string;
  detail?: string[];
  durationMs: number;
}

/**
 * Scrub the durable store.
 *
 * Called before *and* after the claim that dirties it. Before, because the audit this claim falsifies is a table scan:
 * a row left by an earlier run would produce the expected failure on its own, and the claim would pass for a reason
 * that has nothing to do with the regression it injected.
 */
async function scrub(label: string): Promise<string> {
  const result = await shell(['bun', 'run', 'secrets:audit', '--', '--scrub']);
  // stdout, not the merged output: `bun run` echoes the command it is about to run on **stderr**, so a "last line" read
  // across both streams reports the command line instead of its result.
  const lines = result.stdout.split('\n').filter((entry) => entry.trim().length > 0);
  const line = lines[lines.length - 1]?.trim() ?? '';
  return `${label}: ${line || `no output (exit ${result.code})`}`;
}

async function main(): Promise<void> {
  if (needsBrowser && withoutBrowser) {
    console.error('--needs-browser and --without-browser select nothing together');
    process.exit(2);
  }
  const selected = wanted ? CLAIMS.filter((claim) => wanted.includes(claim.id)) : CLAIMS;
  if (selected.length === 0) {
    console.error(`no claim matches --only ${only}. Known: ${CLAIMS.map((claim) => claim.id).join(', ')}`);
    process.exit(2);
  }
  const claims = selected.filter((claim) =>
    needsBrowser ? claim.needsBrowser === true : withoutBrowser ? claim.needsBrowser !== true : true,
  );
  if (claims.length === 0) {
    // The selection, not the ids: `--only` found its claims and this flag then took them all away, which is the one
    // way a caller can ask for a family this stack cannot run and be told so before a container is touched.
    console.error(`${needsBrowser ? 'no claim needs a browser' : 'every selected claim needs a browser'}`);
    process.exit(2);
  }
  // An id named on the command line and then taken away by one of the family flags is the same mistake as a typo, and
  // it is refused rather than warned about for the same reason: a claim that was never run reads exactly like a claim
  // that passed. The two jobs name one half each and no ids, so nothing legitimate reaches this.
  for (const id of wanted ?? []) {
    if (selected.some((claim) => claim.id === id) && !claims.some((claim) => claim.id === id)) {
      console.error(
        `${id} is excluded by ${needsBrowser ? '--needs-browser' : '--without-browser'}, which the same command asks for`,
      );
      process.exit(2);
    }
  }
  // Named ids that matched nothing are not silently dropped: a typo would otherwise run a smaller set than the caller
  // asked for, which reads exactly like the claim having passed.
  for (const id of wanted ?? []) {
    if (!CLAIMS.some((claim) => claim.id === id)) {
      console.error(`no claim matches --only ${id}. Known: ${CLAIMS.map((claim) => claim.id).join(', ')}`);
      process.exit(2);
    }
  }

  /**
   * The pre-flight, skipped when *every* selected claim brings its own position.
   *
   * Every other claim here drives the API as a caller with no account, and on a tenant-first stack each would exit 3
   * ("the case could not run") — which reads as a **failed** claim by design, so the honest output is one gap naming
   * the stack rather than eighty failures (`e2e/lib/stack-gap.ts`). The strict claims are the exception and provably
   * so: their position is asserted by `enterStrictPosition` from the API's own answer, which is a stronger check than
   * this pre-flight makes. Running `--only strict-…` on any stack is therefore expected to work; running the whole
   * stage on a stack that serves nobody is still a gap, because the other eighty-six claims really cannot run.
   */
  const allClaimsBringTheirOwnPosition = claims.length > 0 && claims.every((claim) => claim.position === 'strict');
  if (!allClaimsBringTheirOwnPosition) {
    await requireAnonymousUse(base, 'every claim here drives the API as a caller with no account');
  }

  console.log(`falsify → ${base}, ${claims.length} claim(s)\n`);

  const verdicts: Verdict[] = [];

  for (const [index, claim] of claims.entries()) {
    const started = Date.now();
    console.log(`── ${claim.id} ──`);
    console.log(`  invariant: ${claim.invariant}`);
    console.log(`  injected:  ${claim.regression}`);

    const services = [claim.service];
    const scrubNotes: string[] = [];
    // Read inside the `try` but declared out here, because the `finally` needs it: a `checkout` claim restores the image
    // by writing these exact bytes back, and a `served-asset` one puts the asset back byte for byte. Empty when the read
    // itself failed, in which case the claim reports an error and there is nothing to restore — the recreation below is
    // the real restore point, and it is the image's own bytes either way.
    let source = '';
    let served: { path: string; bytes: string } | null = null;

    try {
      if (claim.mutate === 'served-asset') {
        // The subject is the bundle nginx serves, which exists only in the image: the glob is resolved to exactly one
        // file first, and the copy under test is read out of the container. A missing `asset` is a claim that cannot
        // say what it patches, so it says nothing — the same reading the two other modes give a missing `path`.
        if (!claim.asset) throw new Error(`${claim.id} is a served-asset claim with no asset to patch`);
        served = await resolveServedAsset(claim.service, claim.asset, claim.from);
        source = served.bytes;
      } else {
        if (!claim.path) throw new Error(`${claim.id} is a ${claim.mutate ?? 'container'} claim with no path to patch`);
        source = await Bun.file(join(REPO_ROOT, claim.path)).text();
      }
      const where = served?.path ?? claim.path ?? '(no path)';
      const occurrences = patchSites(source, claim.from);
      if (occurrences === 0) {
        // The patch target is gone, which means the invariant moved or was deleted. That is a finding about this
        // stage, not about the product, and it has to be loud: a claim that cannot patch its target is a claim that
        // is testing nothing, and it would otherwise report a pass by running an unmodified case. For a served asset
        // this is also the check that catches a **leftover patch** from an interrupted run — the patch removes its own
        // target, so the second run says the claim is stale rather than quietly testing nothing.
        throw new Error(
          `${where} no longer contains the line this claim patches — the claim is stale:\n    ${String(claim.from)}`,
        );
      }
      if (occurrences > 1) {
        throw new Error(`${where} contains the patch target ${occurrences} times; a claim has to name one site`);
      }

      // Before the patch goes in, not after: a container still holding the *previous* patch would fail the case for a
      // reason this claim did not inject, and the verdict would read as a product defect.
      //
      // Skipped for a `checkout` claim, and not as a shortcut: the digest compares the container's copy of the file
      // against the checkout's, and the `web` image has no copy — its runtime layer is nginx and the built bundle. It
      // was tried and it reported "running a patched file" on every run, because `sha256sum … | cut -d' ' -f1` exits 0
      // (the pipeline's status is `cut`'s) and prints nothing, which is indistinguishable from a mismatch. What catches
      // a leftover patch for those claims is the `from` occurrence check above: the patch removes its own target, so a
      // second run says the claim is stale instead of quietly testing nothing.
      //
      // A `served-asset` claim is skipped for the same reason — there is no checkout file to compare against — and the
      // same check above is what guards it.
      if (!claim.mutate || claim.mutate === 'container') {
        await assertRunningTheBuiltImage(claim.service, claim.path ?? '', source);
      }

      if (claim.dirties) scrubNotes.push(await scrub('store before'));

      // Before the patch, never after: a claim measured on a stack that is not in its position is a claim about
      // nothing, and it would report a *pass* (the case cannot see a regression that is not in front of it).
      if (claim.position === 'strict' && !strictPosition) {
        await enterStrictPosition();
        strictPosition = true;
      }

      if (claim.needsAnonymousSession && !strictSessionCookie) {
        throw new Error(
          'this claim measures a visitor who holds a session this installation refuses, and neither the dev stack nor ' +
            'the stub minted one — anonymous use is off in both places, which is a stack fact to fix rather than a ' +
            'verdict about the claim',
        );
      }

      const patched = source.replace(claim.from, claim.to);
      if (claim.mutate === 'served-asset') {
        // No rebuild and no restart: nginx serves these bytes off its own filesystem, so the patch is live on the next
        // request — and the next request is the case's own, since a browser context starts with an empty cache.
        await writeIntoContainer(claim.service, served!.path, patched);
        console.log(`  · ${served!.path}: patched in the served bundle (no rebuild, no restart)`);
      } else if (claim.mutate === 'checkout') {
        // The bundle is built, not mounted (`Dockerfile.web`), so the file written into the container would be a file
        // nothing reads: the patch goes to the checkout and the image is rebuilt from it.
        await Bun.write(join(REPO_ROOT, where), patched);
        console.log(`  · ${where}: patched in the checkout, rebuilding ${claim.service}`);
        const build = await compose(['build', claim.service]);
        if (build.code !== 0) {
          throw new Error(
            `rebuilding ${claim.service} from the patched checkout failed:\n${tail(build.output, 8).join('\n')}`,
          );
        }
        // `--no-deps`, because the restore below recreates one service at a time and a recreate that dragged its
        // dependencies along would pull the **api** back to the dev profile in the middle of the strict group: the
        // next claim would then measure a stack that is not in its position and report the harness's own mistake.
        await compose(['up', '-d', '--force-recreate', '--no-deps', claim.service]);
      } else {
        await writeIntoContainer(claim.service, where, patched);
        console.log(`  · ${claim.service}: patched, restarting`);
        await compose(['restart', claim.service]);
      }
      // Only the modes that restart or recreate a container need this; a served asset is live the moment it is written.
      if (claim.mutate !== 'served-asset' && !(await waitHealthy(claim.service)))
        throw new Error(`${claim.service} did not become healthy after patching`);

      const outcome = await runCase(claim.case);
      const evidence = matchedLine(outcome.output, claim.expect);

      if (outcome.code === STACK_GAP_EXIT_CODE) {
        // The case could not run, which is not a falsification and must never be reported as one — nor as a caught
        // regression. `escalation-byte-threshold` is the one claim in this position: its file is over the stack's
        // upload ceiling unless the stack was started with `MAX_FILE_SIZE_MB` raised (`docs/0-CICD.md` §3).
        throw new Error(`the case could not run on this stack: ${stackGapReason(outcome.output) ?? 'no reason given'}`);
      }

      if (outcome.code === 0) {
        verdicts.push({
          id: claim.id,
          invariant: claim.invariant,
          regression: claim.regression,
          status: 'not-falsified',
          caseExitCode: outcome.code,
          evidence: 'the case passed with the regression injected',
          detail: tail(outcome.output),
          durationMs: Date.now() - started,
        });
        console.log('  ✗ the case PASSED with the regression injected — this check is not load-bearing');
      } else if (evidence.length === 0) {
        verdicts.push({
          id: claim.id,
          invariant: claim.invariant,
          regression: claim.regression,
          status: 'unexpected-failure',
          caseExitCode: outcome.code,
          evidence: 'the case failed, but not for the reason the claim asserts',
          detail: tail(outcome.output),
          durationMs: Date.now() - started,
        });
        console.log(`  ✗ the case failed for a different reason than ${claim.expect}`);
      } else {
        verdicts.push({
          id: claim.id,
          invariant: claim.invariant,
          regression: claim.regression,
          status: 'falsified',
          caseExitCode: outcome.code,
          evidence,
          durationMs: Date.now() - started,
        });
        console.log(`  ✓ the case failed as it must: ${evidence}`);
      }
    } catch (error) {
      verdicts.push({
        id: claim.id,
        invariant: claim.invariant,
        regression: claim.regression,
        status: 'error',
        caseExitCode: -1,
        evidence: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Always, and by recreation rather than restart: the image is the restore point, so this also discards the API
      // logs the printed-surface claim wrote the password into.
      if (claim.dirties) scrubNotes.push(await scrub('store after'));
      if (claim.mutate === 'served-asset' && served) {
        // The bytes this run read, put back and **checked** rather than assumed: the recreation below is the real
        // restore point, and this is what makes the window between the patch and that recreation safe to read from.
        await writeIntoContainer(claim.service, served.path, served.bytes);
        const digest = await sha256InContainer(claim.service, served.path);
        const expected = new Bun.CryptoHasher('sha256').update(served.bytes).digest('hex');
        const restored = digest === expected;
        console.log(
          `  · ${served.path}: ${restored ? 'restored from the bytes this run read' : 'COULD NOT BE RESTORED'}`,
        );
        if (!restored) {
          verdicts.push({
            id: `${claim.id}:restore-asset`,
            invariant: 'the served asset is restored after a claim',
            regression: '—',
            status: 'error',
            caseExitCode: -1,
            evidence: `${served.path} in ${claim.service} is not the bytes this run read`,
            durationMs: Date.now() - started,
          });
        }
      }
      if (claim.mutate === 'checkout') {
        // The checkout first, so the image rebuilt below is the one these bytes describe — the same order the patch
        // took, and the reason the restore is a rebuild rather than a `git checkout` this script has no business
        // running in someone's working tree.
        const path = claim.path ?? '';
        await Bun.write(join(REPO_ROOT, path), source);
        const restored = await compose(['build', claim.service]);
        console.log(
          `  · ${path}: ${restored.code === 0 ? 'restored from the bytes this run read' : 'COULD NOT BE RESTORED'}`,
        );
      }
      for (const service of services) {
        await compose(['up', '-d', '--force-recreate', '--no-deps', service]);
        const healthy = await waitHealthy(service);
        console.log(`  · ${service}: ${healthy ? 'restored to the built image' : 'DID NOT BECOME HEALTHY'}`);
        if (!healthy) {
          verdicts.push({
            id: `${claim.id}:restore`,
            invariant: 'the container is restored after a claim',
            regression: '—',
            status: 'error',
            caseExitCode: -1,
            evidence: `${service} did not become healthy after --force-recreate`,
            durationMs: Date.now() - started,
          });
        }
      }
      // Left once, at the end of the group — and even when the claim errored, because a stack left strict would make
      // every later claim fail for a reason this script injected.
      if (claim.position === 'strict' && !claims.slice(index + 1).some((next) => next.position === 'strict')) {
        try {
          await leaveStrictPosition();
          strictPosition = false;
        } catch (error) {
          verdicts.push({
            id: `${claim.id}:position`,
            invariant: 'the dev stack is restored after a strict claim',
            regression: '—',
            status: 'error',
            caseExitCode: -1,
            evidence: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          });
          console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const note of scrubNotes) console.log(`  · ${note}`);
    }
    console.log('');
  }

  const falsified = verdicts.filter((verdict) => verdict.status === 'falsified');
  const broken = verdicts.filter((verdict) => verdict.status !== 'falsified');

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    ARTIFACT,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base,
        totals: { claims: claims.length, falsified: falsified.length },
        verdicts,
      },
      null,
      2,
    )}\n`,
  );

  if (broken.length > 0) {
    console.error(`falsify failed — ${broken.length} of ${claims.length} claim(s) did not hold:`);
    for (const verdict of broken) {
      console.error(`  ✗ ${verdict.id} (${verdict.status}): ${verdict.evidence}`);
      for (const line of verdict.detail ?? []) console.error(`      ${line}`);
    }
    console.error(`\nEvery claim and its verdict: ${ARTIFACT}`);
    process.exit(1);
  }

  console.log(
    `falsify passed — ${falsified.length}/${claims.length} claim(s) falsified, every injected regression caught`,
  );
  console.log(`Verdicts: ${ARTIFACT}`);
}

await main();
