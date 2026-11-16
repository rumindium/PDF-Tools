import { readFile } from 'node:fs/promises';
import { Glob } from 'bun';

/**
 * Enforces the import rules from `docs/0-FOLDER-STRUCTURE.md` §6.
 *
 * Each rule encodes a decision that is expensive to reverse later:
 *
 *   * `apps/api` must not import `@pdftools/engines` — the API must never run a conversion, and the API image
 *     ships without engines. A boundary that is only a convention is discovered the day it is broken.
 *   * `apps/web` must not import the database, queue, logger, or engines — anything the browser can reach is
 *     public, so a database driver or a Redis client in a bundle is both a size problem and a disclosure surface.
 *   * workers must not import `apps/*` — a handler that reaches into the HTTP layer drags its whole dependency
 *     graph into a pool whose only job is to convert bytes.
 *   * packages must not import apps or workers — the dependency direction is one way.
 *
 * It scans import *specifiers* (static imports, re-exports, and dynamic `import()`), so a violation cannot hide
 * behind a re-export.
 *
 *   bun run boundaries
 */

const ROOT_URL = new URL('../../', import.meta.url);
const ROOT_PATH = ROOT_URL.pathname;

interface Rule {
  /** Directory the rule applies to, relative to the repository root. */
  scope: string;
  forbidden: Array<{ pattern: RegExp; why: string }>;
}

const RULES: Rule[] = [
  {
    scope: 'apps/api',
    forbidden: [
      { pattern: /^@pdftools\/engines$/, why: 'the API must never spawn a conversion engine' },
      { pattern: /(^|\/)workers\//, why: 'the API does not own worker code' },
    ],
  },
  {
    scope: 'apps/web',
    forbidden: [
      { pattern: /^@pdftools\/db$/, why: 'a database driver must never be bundled for the browser' },
      { pattern: /^@pdftools\/queue$/, why: 'Redis and BullMQ belong server-side' },
      { pattern: /^@pdftools\/engines$/, why: 'a browser cannot spawn an engine' },
      { pattern: /^@pdftools\/logger$/, why: 'pino is a server logger' },
      { pattern: /(^|\/)apps\/api\//, why: 'no server routes in the bundle' },
    ],
  },
  {
    scope: 'workers',
    forbidden: [
      { pattern: /(^|\/)apps\/api\//, why: 'workers must not depend on the HTTP layer' },
      { pattern: /(^|\/)apps\/web\//, why: 'workers have no UI' },
    ],
  },
  {
    scope: 'packages',
    forbidden: [
      { pattern: /(^|\/)apps\//, why: 'packages must not depend upwards' },
      { pattern: /(^|\/)workers\//, why: 'packages must not depend upwards' },
    ],
  },
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/g;

async function main() {
  const violations: string[] = [];
  let scanned = 0;

  const glob = new Glob('{apps,workers,packages}/**/*.{ts,tsx}');
  for await (const relativePath of glob.scan({ cwd: ROOT_PATH, onlyFiles: true })) {
    if (relativePath.includes('node_modules')) continue;

    const rules = RULES.filter((rule) => relativePath.startsWith(`${rule.scope}/`));
    if (rules.length === 0) continue;

    scanned += 1;
    const source = await readFile(new URL(relativePath, ROOT_URL), 'utf8');

    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;

      for (const rule of rules) {
        for (const forbidden of rule.forbidden) {
          if (forbidden.pattern.test(specifier)) {
            violations.push(`${relativePath} imports "${specifier}" — ${forbidden.why}`);
          }
        }
      }
    }
  }

  console.log(`checked ${scanned} source files across ${RULES.length} scopes`);

  if (violations.length > 0) {
    console.error(`\n${violations.length} boundary violation(s):\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }

  console.log('no boundary violations');
}

await main();
