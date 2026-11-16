import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '@pdftools/contracts';
import { ID_TOOL_IDS } from '../../apps/seo/src/lib/id';
import { OG_IMAGE_TOOLS } from '../../apps/web/src/lib/seo';

/**
 * The snapshot freshness check (F3/T4): after both builds, every registry tool must have a snapshot file, and
 * every snapshot page must carry what a crawler reads — an `<h1>`, a canonical, and parseable JSON-LD with the
 * schemas its page type promises.
 *
 * This is the check that catches serving `web/dist` without `seo/dist`, a catalog addition without a rebuild,
 * and a template edit that dropped a script block. It reads files, not a stack, so it runs anywhere both builds
 * exist:
 *
 *   bun run build                  # web + seo (Dockerfile.web does both)
 *   bun run seo:snapshot -- --dir apps/seo/dist
 *
 * Unit tests (`apps/web/src/lib/seo-snapshot.test.ts`) pin the builders and the single-sourcing; this script pins
 * the *built output* — the thing nginx actually serves to crawlers.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? null;
}

interface PageExpectation {
  file: string;
  /** Schemas that must appear among the page's JSON-LD blocks. */
  types: string[];
}

function extractJsonLd(html: string, file: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (!body) throw new Error(`${file}: an empty JSON-LD block`);
    try {
      blocks.push(JSON.parse(body) as Record<string, unknown>);
    } catch {
      throw new Error(`${file}: a JSON-LD block does not parse: ${body.slice(0, 120)}`);
    }
  }
  return blocks;
}

/** The English twin of a snapshot canonical: `/id/...` back to `/...`, anything else to itself. */
function enTwin(canonical: string): string {
  return canonical.replace(/\/id(\/|$)/, '/');
}

function checkHreflang(html: string, file: string, canonical: string, translated: boolean): string[] {
  const failures: string[] = [];
  const alternates = new Map<string, string>();
  for (const match of html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)) {
    const lang = match[1];
    const href = match[2];
    if (lang && href) alternates.set(lang, href);
  }
  const isId = file.startsWith(`id${'/'}`);
  if (alternates.get('x-default') !== enTwin(canonical)) {
    failures.push(`${file}: x-default must name the English twin (${enTwin(canonical)})`);
  }
  if (isId) {
    if (alternates.get('id') !== canonical) failures.push(`${file}: hreflang id must be self-canonical`);
    if (alternates.get('en') !== enTwin(canonical)) {
      failures.push(`${file}: hreflang en must name the English twin (${enTwin(canonical)})`);
    }
  } else {
    if (alternates.get('en') !== canonical) failures.push(`${file}: hreflang en must be self-canonical`);
    const idHref = alternates.get('id');
    if (translated && !idHref) failures.push(`${file}: translated page names no Indonesian alternate`);
    if (!translated && idHref) failures.push(`${file}: untranslated page must not claim an Indonesian alternate`);
  }
  return failures;
}

async function checkPage(
  dir: string,
  { file, types, translated = false }: PageExpectation & { translated?: boolean },
): Promise<string[]> {
  const failures: string[] = [];
  const path = join(dir, file);
  if (!existsSync(path)) return [`missing snapshot file: ${file}`];
  const html = await readFile(path, 'utf8');
  if (!/<h1[\s>]/.test(html)) failures.push(`${file}: no <h1> — a tool page without a heading is not a landing page`);
  const canonicalMatch = html.match(/<link rel="canonical" href="(https?:\/\/[^"]+)">/);
  if (!canonicalMatch?.[1]) {
    failures.push(`${file}: no absolute canonical link`);
  } else {
    failures.push(...checkHreflang(html, file, canonicalMatch[1], translated));
  }
  let blocks: Array<Record<string, unknown>> = [];
  try {
    blocks = extractJsonLd(html, file);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (blocks.length === 0) failures.push(`${file}: no JSON-LD blocks`);
  const found = new Set(blocks.map((block) => block['@type']));
  for (const type of types) {
    if (!found.has(type)) failures.push(`${file}: JSON-LD has no ${type}`);
  }
  return failures;
}

async function main(): Promise<void> {
  const dir = resolve(REPO_ROOT, arg('--dir') ?? join('apps', 'seo', 'dist'));
  // OG covers ship with the web bundle, not the snapshot (`Dockerfile.web` copies `web/dist` to the html root
  // and `seo/dist` to the snapshot dir) — the snapshot only *points* at them with absolute URLs.
  const webDir = resolve(REPO_ROOT, arg('--web-dir') ?? join('apps', 'web', 'dist'));
  const idSet = new Set<string>(ID_TOOL_IDS);
  const pages: Array<PageExpectation & { translated?: boolean }> = [
    { file: 'index.html', types: ['WebSite', 'WebApplication'], translated: true },
    { file: join('tools', 'index.html'), types: ['CollectionPage', 'ItemList'], translated: true },
    ...TOOLS.map((tool) => ({
      file: join('tools', tool.id, 'index.html'),
      types: ['WebPage', 'SoftwareApplication', 'BreadcrumbList', 'HowTo', 'FAQPage'],
      translated: idSet.has(tool.id),
    })),
    { file: join('id', 'index.html'), types: ['WebSite', 'WebApplication'] },
    { file: join('id', 'tools', 'index.html'), types: ['CollectionPage', 'ItemList'] },
    ...TOOLS.filter((tool) => idSet.has(tool.id)).map((tool) => ({
      file: join('id', 'tools', tool.id, 'index.html'),
      types: ['WebPage', 'SoftwareApplication', 'BreadcrumbList', 'HowTo', 'FAQPage'],
    })),
  ];

  const failures: string[] = [];
  for (const page of pages) {
    failures.push(...(await checkPage(dir, page)));
  }

  // Per-tool OG covers are versioned statics, not build output: a builder pointing at a missing file unfurls
  // nothing. Shared fallback needs no check — it has shipped since the first cover.
  for (const id of OG_IMAGE_TOOLS) {
    if (!existsSync(join(webDir, 'og', `${id}.png`))) failures.push(`missing OG cover: og/${id}.png`);
  }

  if (failures.length > 0) {
    console.error(`seo:snapshot ${failures.length} failure(s) in ${dir}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `seo:snapshot OK — ${pages.length} pages (${TOOLS.length} tools), each with <h1>, canonical and JSON-LD, plus ${OG_IMAGE_TOOLS.length} OG covers`,
  );
}

await main();
