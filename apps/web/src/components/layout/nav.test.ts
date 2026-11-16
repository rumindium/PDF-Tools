import { describe, expect, test } from 'bun:test';
import { type Catalog, type CatalogEntry, TOOLS } from '@pdftools/contracts/tools';
import { IconFileText } from '../icons';
import {
  CATEGORY_ORDER,
  type NavIcon,
  TOOL_ICONS,
  activeGroupId,
  categoryIcon,
  crumbs,
  orderCategories,
  toolIcon,
  toolNavGroups,
} from './nav';

/**
 * The navigation rules, asserted as rules.
 *
 * Three of them can rot without anybody noticing, which is why they are here rather than left to the browser suite:
 *
 *  - **Every catalog tool reaches the nav exactly once.** A tool that exists and cannot be found is worse than one
 *    that does not exist, and the failure mode is silent — the grid on `/tools` would still show it.
 *  - **The category order is stable and never drops an unknown category.** The sidebar's ordering is a design
 *    decision; its *completeness* is not negotiable.
 *  - **A URL belongs to exactly one group, and the breadcrumb table has no hole in it.** The open group and the
 *    breadcrumb are how a person knows where they are; a tool page whose category is closed looks like a page that
 *    is nowhere.
 */

function entry(id: string, title: string, category: string): CatalogEntry {
  return {
    id,
    title,
    category,
    summary: `${title} summary`,
    phase: 1,
    enabled: true,
    available: true,
    secrets: [],
    setsPasswords: [],
  } as unknown as CatalogEntry;
}

function catalog(tools: CatalogEntry[]): Catalog {
  return { catalogVersion: 1, tools } as unknown as Catalog;
}

const SAMPLE = catalog([
  entry('merge', 'Merge PDF', 'organize'),
  entry('split', 'Split PDF', 'organize'),
  entry('ocr', 'OCR', 'ocr'),
  entry('compress', 'Compress PDF', 'optimize'),
  entry('encrypt', 'Protect PDF', 'security'),
  entry('weird', 'Weird tool', 'brand-new'),
]);

describe('orderCategories', () => {
  test('known categories keep their reading order', () => {
    expect(orderCategories(['ocr', 'organize', 'convert'])).toEqual(['organize', 'convert', 'ocr']);
  });

  test('an unknown category is kept, after the known ones and alphabetically', () => {
    expect(orderCategories(['zebra', 'ocr', 'apple'])).toEqual(['ocr', 'apple', 'zebra']);
  });

  test('duplicates collapse to one', () => {
    expect(orderCategories(['organize', 'organize'])).toEqual(['organize']);
  });

  test('every declared category survives a round trip', () => {
    expect(orderCategories(CATEGORY_ORDER)).toEqual([...CATEGORY_ORDER]);
  });
});

describe('toolNavGroups', () => {
  test('every tool appears exactly once, under its own category', () => {
    const groups = toolNavGroups(SAMPLE);
    const seen = groups.flatMap((group) => group.children?.map((child) => `${group.id}/${child.id}`) ?? []);
    expect(seen).toHaveLength(SAMPLE.tools.length);
    expect(new Set(seen).size).toBe(SAMPLE.tools.length);
    expect(seen).toContain('brand-new/weird');
    expect(seen).toContain('ocr/ocr');
  });

  test('a group points at its filtered catalog and counts its own children', () => {
    const organize = toolNavGroups(SAMPLE).find((group) => group.id === 'organize');
    expect(organize?.to).toBe('/tools?category=organize');
    expect(organize?.count).toBe(organize?.children?.length);
  });

  test('no catalog yet means no groups, not a crash', () => {
    expect(toolNavGroups(null)).toEqual([]);
  });
});

/**
 * The icon rules, and the two that can rot silently.
 *
 * The table is data in the frontend while the catalog is data in the contracts package, so nothing at build time
 * connects them: a tool shipped tomorrow would simply borrow its category's glyph and every screen would still
 * render. "Every catalog tool has an entry" is therefore asserted against the **real** catalog rather than a sample,
 * because the sample cannot notice a tool that was added after this file was written.
 *
 * The second rule is the one a reviewer cannot see: two tools under one heading wearing the same glyph is a column
 * of identical shapes, which is the thing the per-tool table exists to avoid. A tool sharing its *category's* glyph
 * is fine and sometimes right (`ocr` is its category) — sharing a *sibling's* is not.
 */
describe('toolIcon', () => {
  test('a tool nobody has drawn yet borrows its category rather than showing nothing', () => {
    expect(toolIcon('brand-new', 'ocr')).toBe(categoryIcon('ocr'));
    expect(toolIcon('brand-new', 'not-a-category')).toBe(IconFileText);
    expect(toolIcon('brand-new')).toBe(IconFileText);
  });

  test('every tool in the real catalog has an entry of its own', () => {
    const missing = TOOLS.filter((tool) => !(tool.id in TOOL_ICONS)).map((tool) => tool.id);
    expect(missing).toEqual([]);
  });

  test('no two tools under one category wear the same glyph', () => {
    const clashes: string[] = [];
    for (const category of orderCategories(TOOLS.map((tool) => tool.category))) {
      const seen = new Map<NavIcon, string>();
      for (const tool of TOOLS.filter((candidate) => candidate.category === category)) {
        const icon = toolIcon(tool.id, tool.category);
        const twin = seen.get(icon);
        if (twin) clashes.push(`${category}: ${twin} and ${tool.id}`);
        seen.set(icon, tool.id);
      }
    }
    expect(clashes).toEqual([]);
  });

  test('every row the navigation builds carries its glyph', () => {
    const children = toolNavGroups(SAMPLE).flatMap((group) => group.children ?? []);
    expect(children).toHaveLength(SAMPLE.tools.length);
    expect(children.every((child) => typeof child.icon === 'function')).toBe(true);
  });
});

describe('activeGroupId', () => {
  const groups = toolNavGroups(SAMPLE);

  test('a tool page opens its category', () => {
    expect(activeGroupId({ pathname: '/tools/merge', search: '' }, groups)).toBe('organize');
    expect(activeGroupId({ pathname: '/tools/ocr', search: '' }, groups)).toBe('ocr');
  });

  test('the filtered catalog opens its category', () => {
    expect(activeGroupId({ pathname: '/tools', search: '?category=security' }, groups)).toBe('security');
  });

  test('the unfiltered catalog belongs to no category', () => {
    expect(activeGroupId({ pathname: '/tools', search: '' }, groups)).toBeNull();
    expect(activeGroupId({ pathname: '/tools', search: '?category=organize' }, groups)).toBe('organize');
  });

  test('pages outside the tools open nothing', () => {
    expect(activeGroupId({ pathname: '/jobs', search: '' }, groups)).toBeNull();
    expect(activeGroupId({ pathname: '/', search: '' }, groups)).toBeNull();
  });
});

describe('crumbs', () => {
  test('a tool page names the tool, and says so from the catalog', () => {
    expect(crumbs('/tools/merge', { toolTitle: 'Merge PDF' })).toEqual([
      { label: 'Home', to: '/' },
      { label: 'Tools', to: '/tools' },
      { label: 'Merge PDF' },
    ]);
  });

  test('a tool page with no title in hand falls back to the id rather than to an empty crumb', () => {
    expect(crumbs('/tools/merge').at(-1)).toEqual({ label: 'merge' });
  });

  test('the cheap pages are one hop from home', () => {
    expect(crumbs('/').map((crumb) => crumb.label)).toEqual(['Home']);
    expect(crumbs('/tools').map((crumb) => crumb.label)).toEqual(['Home', 'Tools']);
    expect(crumbs('/jobs').map((crumb) => crumb.label)).toEqual(['Home', 'Jobs']);
    expect(crumbs('/account').map((crumb) => crumb.label)).toEqual(['Home', 'Usage']);
  });

  test('a nested job keeps a way back to the list', () => {
    expect(crumbs('/jobs/abc')).toEqual([{ label: 'Home', to: '/' }, { label: 'Jobs', to: '/jobs' }, { label: 'Job' }]);
  });

  test('an unknown path is still somewhere, not nothing', () => {
    expect(crumbs('/nope').map((crumb) => crumb.label)).toEqual(['Home']);
  });
});
