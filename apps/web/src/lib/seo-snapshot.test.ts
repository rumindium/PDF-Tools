import { describe, expect, test } from 'bun:test';
import { TOOLS } from '@pdftools/contracts/tools';
import { homeSeo, toolSeo, toolsIndexSeo } from './seo';

/**
 * The SPA ≡ snapshot contract (`lib/seo.ts`, `apps/seo`).
 *
 * The snapshot pages import the SPA's builders directly, so copy cannot drift one layer at a time the way it
 * did when both were hand-written (category keywords went missing from the snapshot, the tools count from its
 * title). These tests pin both halves of that arrangement: the `.astro` files really do take their head tags
 * from the builders, and everything the builders emit is JSON-LD a validator accepts.
 */

const SEO_DIR = new URL('../../../seo/src/pages/', import.meta.url);

async function astroSource(relative: string): Promise<string> {
  return Bun.file(new URL(relative, SEO_DIR)).text();
}

function nonEmpty(value: unknown): asserts value is string {
  expect(typeof value).toBe('string');
  expect((value as string).length).toBeGreaterThan(0);
}

function absoluteUrl(value: unknown): void {
  nonEmpty(value);
  expect(value).toMatch(/^https:\/\//);
}

/** Every schema the builders emit, with the fields a rich-result validator requires. Unknown blocks fail loudly. */
function expectJsonLdValid(blocks: Array<Record<string, unknown>> | undefined): void {
  expect(Array.isArray(blocks)).toBe(true);
  expect((blocks ?? []).length).toBeGreaterThan(0);
  for (const block of blocks ?? []) {
    // Astro emits each block with `JSON.stringify`, so the builder output must survive a JSON round-trip
    // exactly — `undefined` or a function would silently vanish from the snapshot while the SPA still sees it.
    expect(JSON.parse(JSON.stringify(block))).toEqual(block);
    switch (block['@type']) {
      case 'WebSite': {
        nonEmpty(block.name);
        absoluteUrl(block.url);
        expect(block.inLanguage).toBe('en');
        break;
      }
      case 'Organization': {
        nonEmpty(block.name);
        absoluteUrl(block.url);
        absoluteUrl(block.logo);
        break;
      }
      case 'WebApplication':
      case 'SoftwareApplication': {
        nonEmpty(block.name);
        absoluteUrl(block.url);
        nonEmpty(block.applicationCategory);
        nonEmpty(block.operatingSystem);
        const offers = block.offers as Record<string, unknown>;
        expect(offers?.['@type']).toBe('Offer');
        expect(offers?.price).toBe('0');
        break;
      }
      case 'WebPage':
      case 'CollectionPage': {
        nonEmpty(block.name);
        absoluteUrl(block.url);
        nonEmpty(block.description);
        break;
      }
      case 'BreadcrumbList':
      case 'ItemList': {
        const items = block.itemListElement as Array<Record<string, unknown>>;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThan(0);
        items.forEach((item, index) => {
          expect(item['@type']).toBe('ListItem');
          expect(item.position).toBe(index + 1);
          nonEmpty(item.name);
          if (block['@type'] === 'ItemList') absoluteUrl(item.url);
        });
        break;
      }
      case 'HowTo': {
        nonEmpty(block.name);
        const steps = block.step as Array<Record<string, unknown>>;
        expect(Array.isArray(steps)).toBe(true);
        expect(steps.length).toBeGreaterThan(0);
        steps.forEach((step, index) => {
          expect(step['@type']).toBe('HowToStep');
          expect(step.position).toBe(index + 1);
          nonEmpty(step.name);
          nonEmpty(step.text);
        });
        break;
      }
      case 'FAQPage': {
        const questions = block.mainEntity as Array<Record<string, unknown>>;
        expect(Array.isArray(questions)).toBe(true);
        expect(questions.length).toBeGreaterThan(0);
        for (const question of questions) {
          expect(question['@type']).toBe('Question');
          nonEmpty(question.name);
          const answer = question.acceptedAnswer as Record<string, unknown>;
          expect(answer?.['@type']).toBe('Answer');
          nonEmpty(answer?.text);
        }
        break;
      }
      default:
        throw new Error(
          `unexpected @type ${String(block['@type'])} — the validator must know every schema the builders emit`,
        );
    }
  }
}

describe('snapshot parity', () => {
  test('the home snapshot takes its head tags from homeSeo', async () => {
    const source = await astroSource('index.astro');
    expect(source).toContain("from '../../../web/src/lib/seo'");
    expect(source).toContain('homeSeo()');
    expect(source).not.toContain('const title =');
  });

  test('the tools snapshot takes its head tags from toolsIndexSeo', async () => {
    const source = await astroSource('tools/index.astro');
    expect(source).toContain("from '../../../../web/src/lib/seo'");
    expect(source).toContain('toolsIndexSeo(');
    expect(source).not.toContain('const title =');
  });

  test('the tool snapshot takes its head tags from toolSeo', async () => {
    const source = await astroSource('tools/[id].astro');
    expect(source).toContain("from '../../../../web/src/lib/seo'");
    expect(source).toContain('toolSeo({');
    expect(source).not.toContain('const title =');
    expect(source).not.toContain('const keywords =');
  });
});

describe('JSON-LD validity', () => {
  test('home schemas carry the fields rich results require', () => {
    expectJsonLdValid(homeSeo().jsonLd);
  });

  test('the catalog schemas validate with and without an item list', () => {
    expectJsonLdValid(
      toolsIndexSeo(
        TOOLS.length,
        TOOLS.map((tool) => ({ id: tool.id, title: tool.title, summary: tool.summary })),
      ).jsonLd,
    );
    expectJsonLdValid(toolsIndexSeo(0).jsonLd);
  });

  test('every registry tool validates — one bad category must not ship 33 bad pages', () => {
    for (const tool of TOOLS) {
      expectJsonLdValid(
        toolSeo({
          id: tool.id,
          title: tool.title,
          summary: tool.summary,
          category: tool.category,
          maxFiles: tool.input.maxFiles,
          extensions: tool.input.extensions,
        }).jsonLd,
      );
    }
  });
});
