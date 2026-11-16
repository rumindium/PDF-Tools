import { describe, expect, test } from 'bun:test';
import { SITE_CONTENT_DATE, homeSeo, noIndexSeo, ogImageFor, pricingSeo, toolSeo, toolsIndexSeo } from './seo';

/**
 * The head tags every public page serves (`lib/seo.ts`).
 *
 * Canonicals must be absolute, stable under query strings, and identical for
 * the SPA and the Astro snapshot — a crawler that compares the two and finds
 * different canonicals reads one of them as a lie.
 */
describe('homeSeo', () => {
  test('home is indexable with an absolute canonical', () => {
    const meta = homeSeo();
    expect(meta.robots).toContain('index');
    expect(meta.canonical).toMatch(/^https?:\/\//);
    expect(meta.canonical.endsWith('/')).toBe(true);
  });
});

describe('toolSeo', () => {
  test('a tool page carries SoftwareApplication, HowTo and breadcrumb schemas', () => {
    const meta = toolSeo({ id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.', category: 'organize' });
    expect(meta.canonical).toContain('/tools/merge');
    expect(meta.ogType).toBe('article');
    const types = (meta.jsonLd ?? []).map((block) => block['@type']);
    expect(types).toContain('SoftwareApplication');
    expect(types).toContain('BreadcrumbList');
    expect(types).toContain('FAQPage');
    expect(types).toContain('HowTo');
    expect(types).toContain('WebPage');
  });

  test('tool copy promises free with no paywall tiers', () => {
    const meta = toolSeo({ id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.', category: 'organize' });
    expect(meta.description).toContain('no signup');
    expect(JSON.stringify(meta.jsonLd)).not.toMatch(/Pro\/Business/);
  });

  test('query strings never leak into the canonical', () => {
    const meta = toolSeo({ id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.', category: 'organize' });
    expect(meta.canonical).not.toContain('?');
  });
});

describe('toolsIndexSeo', () => {
  test('the catalog page is indexable', () => {
    expect(toolsIndexSeo(33).robots).toContain('index');
    expect(toolsIndexSeo(33).canonical).toContain('/tools');
  });

  test('a tool list adds an ItemList for rich results', () => {
    const meta = toolsIndexSeo(2, [
      { id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.' },
      { id: 'split', title: 'Split PDF', summary: 'Split PDFs.' },
    ]);
    const types = (meta.jsonLd ?? []).map((block) => block['@type']);
    expect(types).toContain('ItemList');
    expect(toolsIndexSeo(2).jsonLd?.map((block) => block['@type'])).not.toContain('ItemList');
  });
});

describe('ogImageFor', () => {
  test('covered tools get their own cover, everything else the shared one', () => {
    expect(ogImageFor('merge')).toContain('/og/merge.png');
    expect(ogImageFor('ocr')).toContain('/og/ocr.png');
    expect(ogImageFor('rotate')).toContain('/og-cover.png');
    expect(ogImageFor()).toContain('/og-cover.png');
    expect(
      toolSeo({ id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.', category: 'organize' }).ogImage,
    ).toContain('/og/merge.png');
  });
});

describe('tool dates', () => {
  test('WebPage and HowTo carry the content date', () => {
    const blocks =
      toolSeo({ id: 'merge', title: 'Merge PDF', summary: 'Combine PDFs.', category: 'organize' }).jsonLd ?? [];
    for (const type of ['WebPage', 'HowTo']) {
      const block = blocks.find((candidate) => candidate['@type'] === type);
      expect(block?.datePublished).toBe(SITE_CONTENT_DATE);
    }
  });
});

describe('pricingSeo', () => {
  test('the legacy pricing URL is indexable and claims free, not a redirect', () => {
    const meta = pricingSeo();
    expect(meta.robots).toContain('index');
    expect(meta.canonical).toContain('/pricing');
    expect(meta.description).toMatch(/no signup/);
    expect(meta.jsonLd?.map((block) => block['@type'])).toContain('WebPage');
  });
});

describe('noIndexSeo', () => {
  test('private pages are never indexed but keep a canonical', () => {
    const meta = noIndexSeo('/drive', 'My Drive', 'Files this account kept.');
    expect(meta.robots).toContain('noindex');
    expect(meta.canonical).toContain('/drive');
  });
});
