import type { Catalog } from '@pdftools/contracts/tools';
import type { ComponentType } from 'react';
import {
  IconArchive,
  IconClock,
  IconCode,
  IconCompress,
  IconCrop,
  IconDocExport,
  IconDocImport,
  IconEraser,
  IconEyeOff,
  IconFastForward,
  IconFileText,
  IconFormField,
  IconGauge,
  IconGlobe,
  IconGrid,
  IconHash,
  IconHighlighter,
  IconHome,
  IconImage,
  IconImageExport,
  IconKey,
  IconLayers,
  IconListChecks,
  IconLock,
  IconLockOpen,
  IconMerge,
  IconPageExtract,
  IconPageRemove,
  IconPanelTop,
  IconPen,
  IconRefresh,
  IconReorder,
  IconRotate,
  IconScan,
  IconShieldCheck,
  IconSignature,
  IconSplit,
  IconStamp,
  IconTable,
  IconType,
  IconZap,
} from '../icons';

/**
 * The navigation model — every destination the sidebar can show, derived rather than written down twice.
 *
 * The tool list is *not* a constant here: it is built from the catalog the API already computed for this caller, so
 * a tool added to `packages/contracts/tools/catalog.ts` appears in the sidebar with its own title, in its own
 * category, with no second edit. The one thing this file decides is **order and grouping** — which is a design
 * decision and belongs in the frontend, unlike the set of tools.
 *
 * That is also why the functions below are pure: the sidebar is a component, but *which* group a URL belongs to and
 * *what* a breadcrumb should say are rules, and rules tested through a browser are rules nobody tests. `nav.test.ts`
 * covers the three that can rot quietly: every catalog tool reaching the nav exactly once, the category order, and
 * the breadcrumb table.
 */

export type NavIcon = ComponentType<{ size?: number; strokeWidth?: number }>;

export type NavNode = {
  id: string;
  label: string;
  /** Where the row goes. For a group this is the filtered catalog, so a category is a place and not just a label. */
  to: string;
  icon: NavIcon;
  /** A count shown on the right. The tool count, or how many tools a category holds. */
  count?: number;
  children?: NavChild[];
};

export type NavChild = {
  id: string;
  label: string;
  to: string;
  /** The tool's own glyph (`toolIcon`), never undefined: a row without an icon is a row that broke the list. */
  icon: NavIcon;
};

/**
 * The order categories appear in, and it is a reading order, not an alphabetical one.
 *
 * `organize` first because that is what most people arrive with a document to do; `ocr` last because it is the one
 * tool that answers a different question (is this scan readable at all) and does not sit next to any sibling. Any
 * category not named here still appears — after the known ones, alphabetically (`orderCategories`), because a
 * catalog that grows a category must not be able to grow one the sidebar silently drops.
 */
export const CATEGORY_ORDER = ['organize', 'convert', 'optimize', 'edit', 'security', 'document', 'ocr'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  organize: 'Organize',
  convert: 'Convert',
  optimize: 'Optimize',
  edit: 'Edit',
  security: 'Security',
  document: 'Documents',
  ocr: 'OCR',
};

const CATEGORY_ICONS: Record<string, NavIcon> = {
  organize: IconLayers,
  convert: IconRefresh,
  optimize: IconZap,
  edit: IconPen,
  security: IconLock,
  document: IconFileText,
  ocr: IconScan,
};

/** A category's display name, title-cased from the slug when nobody named it — never empty. */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known) return known;
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function categoryIcon(category: string): NavIcon {
  return CATEGORY_ICONS[category] ?? IconFileText;
}

/**
 * One glyph per tool id — the whole table, and the only place a tool's icon is decided.
 *
 * Thirty-three entries rather than a rule derived from the id, because the operations are not compositional: `rotate`
 * and `crop` share a category and nothing else, and `pdf-to-images` is the inverse of `images-to-pdf` rather than a
 * variant of it. A tool that is missing here is not a hole — `toolIcon` falls back to the category's glyph, so a tool
 * added to the catalog tomorrow appears with something sensible instead of an empty box, and the missing entry is a
 * one-line fix rather than a crash.
 *
 * The same glyph is used wherever the tool appears — the navigation, its card, the recent-jobs feed — which is what
 * makes it a face rather than decoration: the row you clicked and the card you clicked it from look like the same
 * thing because they are.
 */
export const TOOL_ICONS: Readonly<Record<string, NavIcon>> = {
  // Organize
  merge: IconMerge,
  split: IconSplit,
  'extract-pages': IconPageExtract,
  'delete-pages': IconPageRemove,
  'reorder-pages': IconReorder,
  rotate: IconRotate,
  crop: IconCrop,
  'n-up': IconGrid,
  // Convert
  'images-to-pdf': IconImage,
  'pdf-to-images': IconImageExport,
  'pdf-to-text': IconType,
  'pdf-to-html': IconCode,
  'pdf-to-csv': IconTable,
  'office-to-pdf': IconDocImport,
  'html-to-pdf': IconGlobe,
  'pdf-to-office': IconDocExport,
  'pdf-to-pdfa': IconArchive,
  // Optimize
  compress: IconCompress,
  'remove-metadata': IconEraser,
  linearize: IconFastForward,
  // Security
  encrypt: IconLock,
  restrict: IconKey,
  unlock: IconLockOpen,
  // Edit
  watermark: IconStamp,
  'page-numbers': IconHash,
  'header-footer': IconPanelTop,
  'edit-pdf': IconPen,
  annotate: IconHighlighter,
  redact: IconEyeOff,
  // Documents
  sign: IconSignature,
  'fill-form': IconFormField,
  'extract-fields': IconListChecks,
  // OCR
  ocr: IconScan,
};

/** A tool's glyph, or its category's when nobody has drawn one for it yet — never nothing. */
export function toolIcon(toolId: string, category?: string): NavIcon {
  return TOOL_ICONS[toolId] ?? (category ? categoryIcon(category) : IconFileText);
}

/** Known categories in reading order, unknown ones alphabetical after them. Deduplicated. */
export function orderCategories(categories: Iterable<string>): string[] {
  const unique = [...new Set(categories)];
  const known = CATEGORY_ORDER.filter((id) => unique.includes(id));
  const rest = unique.filter((id) => !CATEGORY_ORDER.includes(id as (typeof CATEGORY_ORDER)[number])).sort();
  return [...known, ...rest];
}

/** The tools index, filtered to one category — the link a group header points at. */
export function categoryHref(category: string): string {
  return `/tools?category=${encodeURIComponent(category)}`;
}

/**
 * One group per category, one row per tool.
 *
 * Disabled tools are listed rather than hidden. They are in the catalog because the build knows about them
 * (`enabled: false` means this phase has not shipped it), and a tool that exists but is missing from the navigation is
 * the hardest kind of absence to explain: the person saw it in the docs and cannot find it anywhere in the app.
 */
export function toolNavGroups(catalog: Catalog | null): NavNode[] {
  if (!catalog) return [];
  const byCategory = new Map<string, NavChild[]>();
  for (const tool of catalog.tools) {
    const list = byCategory.get(tool.category) ?? [];
    list.push({ id: tool.id, label: tool.title, to: `/tools/${tool.id}`, icon: toolIcon(tool.id, tool.category) });
    byCategory.set(tool.category, list);
  }
  return orderCategories(byCategory.keys()).map((category) => ({
    id: category,
    label: categoryLabel(category),
    to: categoryHref(category),
    icon: categoryIcon(category),
    count: byCategory.get(category)?.length,
    children: byCategory.get(category),
  }));
}

/**
 * The rows above the tools: the workspace, its output, and — for the people the platform gave the app's `admin`
 * permission — the app's administration area. `toolsCount` is `null` while the catalog is still loading, and the
 * row shows no number rather than a wrong one.
 */
export function overviewNav({ toolsCount, canAdmin }: { toolsCount: number | null; canAdmin: boolean }): NavNode[] {
  const rows: NavNode[] = [
    { id: 'home', label: 'Home', to: '/', icon: IconHome },
    {
      id: 'tools',
      label: 'All tools',
      to: '/tools',
      icon: IconGrid,
      ...(toolsCount == null ? {} : { count: toolsCount }),
    },
    { id: 'jobs', label: 'Job history', to: '/jobs', icon: IconClock },
    { id: 'drive', label: 'My Drive', to: '/drive', icon: IconArchive },
    { id: 'account', label: 'Usage', to: '/account', icon: IconGauge },
  ];
  if (canAdmin) {
    rows.push({ id: 'admin', label: 'Administration', to: '/admin', icon: IconShieldCheck });
  }
  return rows;
}

/** The rows below the tools: empty — the app is fully free, so there is no commercial page. */
export function metaNav(): NavNode[] {
  return [];
}

/**
 * Is this link the page the caller is on?
 *
 * One rule for both kinds of row, and the part that matters is the query: `/tools` and `/tools?category=organize` are
 * different places, so "All tools" must not stay lit while a category is selected. A fragment is not part of the
 * answer — `#api` and the page it sits on are the same page.
 */
export function isActiveTarget(node: string, location: { pathname: string; search: string }): boolean {
  const [withoutHash = ''] = node.split('#');
  const [path = '', query] = withoutHash.split('?');
  if (path !== location.pathname) return false;
  const want = query ? new URLSearchParams(query).get('category') : null;
  return want === new URLSearchParams(location.search).get('category');
}

function matches(node: string, location: { pathname: string; search: string }): boolean {
  return isActiveTarget(node, location);
}

/**
 * Which group owns this URL — the group that is opened when the page loads.
 *
 * A tool page belongs to its category (via the child's own href), and `/tools?category=x` belongs to `x`. Both
 * answers come from the group's own links, so there is no second list of rules to keep in step with the first.
 */
export function activeGroupId(location: { pathname: string; search: string }, groups: NavNode[]): string | null {
  for (const group of groups) {
    if (group.children?.some((child) => child.to === location.pathname)) return group.id;
    if (matches(group.to, location)) return group.id;
  }
  return null;
}

export type Crumb = { label: string; to?: string };

/**
 * The breadcrumb for a URL — the whole table, in one place.
 *
 * The topbar's job is to answer "where am I" without the page repeating its own title, and the answer for a tool page
 * is the tool's *name*, which only the catalog knows. That is the one lookup here; everything else is structure.
 */
export function crumbs(pathname: string, ctx: { toolTitle?: string | null } = {}): Crumb[] {
  const home: Crumb = { label: 'Home', to: '/' };
  if (pathname === '/') return [{ label: 'Home' }];
  if (pathname === '/tools') return [home, { label: 'Tools' }];
  if (pathname.startsWith('/tools/')) {
    const id = pathname.slice('/tools/'.length);
    return [home, { label: 'Tools', to: '/tools' }, { label: ctx.toolTitle || id }];
  }
  if (pathname === '/jobs') return [home, { label: 'Jobs' }];
  if (pathname.startsWith('/jobs/')) return [home, { label: 'Jobs', to: '/jobs' }, { label: 'Job' }];
  if (pathname === '/account') return [home, { label: 'Usage' }];
  if (pathname === '/drive') return [home, { label: 'My Drive' }];
  if (pathname === '/admin') return [home, { label: 'Administration' }];
  if (pathname.startsWith('/sso/')) return [home, { label: 'Signing in' }];
  return [home];
}
