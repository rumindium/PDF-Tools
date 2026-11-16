/**
 * SEO helpers — one source for every public page's head tags.
 *
 * The app is a client SPA, so crawlers see `index.html` first and the
 * per-route tags applied at runtime by `<Seo/>`. Keep this module pure
 * (no DOM) so the copy can be unit-tested and reused by the Astro
 * marketing site (`apps/seo`) without a browser.
 *
 * The crawler-first layer (`apps/seo`, served to known crawlers at the same
 * URLs by `infra/nginx/default.conf.template`) imports these builders
 * directly — same titles, descriptions, keywords and schemas — because the
 * snapshot is what a crawler actually reads. Single-sourced on purpose:
 * the hand-mirrored copy drifted within one pass (category keywords went
 * missing from the snapshot, the tools count from its title), so the Astro
 * pages take `title`, `description`, `keywords` and `jsonLd` from here and
 * only build the canonical from `Astro.site`. The JSON-LD `url` fields stay
 * pinned to `SITE_URL`, which equals the production `Astro.site`
 * (`SEO_SITE_URL`); in non-production builds they can name production while
 * the canonical names the local site, which is why the snapshot is only
 * ever deployed from a production build.
 */

export const SITE_URL = 'https://pdf.rumindium.id';
export const SITE_NAME = 'Rumindium PDF Tools';
export const SITE_LOCALE = 'en_US';
export const TWITTER_CARD = 'summary_large_image';

/** `og-cover.png` is 1200×630 (`apps/web/scripts/og-cover.html`). Stated on every page so link unfurls render first try. */
export const OG_IMAGE_WIDTH = '1200';
export const OG_IMAGE_HEIGHT = '630';
export const OG_IMAGE_ALT = 'Rumindium PDF Tools — free online PDF tools in the browser';

/**
 * Tools with their own 1200×630 cover (`public/og/<id>.png`, rendered by `scripts/generate-og-images.mjs`
 * from `og-cover.html`). Five high-traffic tools stay small enough to version; everything else falls back to
 * the shared cover — and `ogImageFor` is the one place that decides, so the SPA and the snapshot agree.
 */
export const OG_IMAGE_TOOLS = ['merge', 'split', 'compress', 'pdf-to-office', 'ocr'] as const;

/**
 * The date the current public copy was published, in `YYYY-MM-DD`. Stated on tool pages (`datePublished` /
 * `dateModified`) as a freshness signal. Bump it when tool copy changes — it is a claim about the words, not
 * the build, which is why it is a constant rather than the build day.
 */
export const SITE_CONTENT_DATE = '2026-10-25';

export function siteUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return SITE_URL;
}

export function ogImage(): string {
  return `${siteUrl()}/og-cover.png`;
}

export function ogImageFor(toolId?: string): string {
  if (toolId && (OG_IMAGE_TOOLS as readonly string[]).includes(toolId)) return `${siteUrl()}/og/${toolId}.png`;
  return ogImage();
}

export const OG_IMAGE = `${SITE_URL}/og-cover.png`;

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  ogType: 'website' | 'article';
  keywords?: string;
  ogImage: string;
  jsonLd?: Record<string, unknown>[];
}

function canonicalFor(path: string): string {
  const clean = (path.split('?')[0] ?? '').split('#')[0] || '/';
  return `${siteUrl()}${clean === '/' ? '/' : clean.replace(/\/$/, '')}`;
}

const HOME_TITLE = 'Free PDF Tools Online — Merge, Split, Compress, Convert, OCR & Sign PDFs';
const HOME_DESCRIPTION =
  'Free online PDF tools with no signup and no watermark: merge, split, compress, convert PDF to Office and images, OCR scans, protect, unlock, watermark and e-sign. Files delete themselves after every job.';

const HOME_KEYWORDS =
  'free pdf tools, merge pdf, split pdf, compress pdf, pdf to word, pdf to jpg, office to pdf, ocr pdf, unlock pdf, sign pdf, watermark pdf, online pdf editor';

export function homeSeo(): SeoMeta {
  const url = canonicalFor('/');
  return {
    title: `${HOME_TITLE} | ${SITE_NAME}`,
    description: HOME_DESCRIPTION,
    canonical: url,
    robots: 'index, follow, max-image-preview:large',
    ogType: 'website',
    keywords: HOME_KEYWORDS,
    ogImage: ogImage(),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url,
        inLanguage: 'en',
      },
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Rumindium',
        url,
        logo: `${siteUrl()}/favicon.svg`,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: SITE_NAME,
        url,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  };
}

export interface ToolsIndexTool {
  id: string;
  title: string;
  summary: string;
}

const TOOLS_INDEX_TITLE = 'All Free PDF Tools — Organize, Convert, Optimize & Security';
const TOOLS_INDEX_DESCRIPTION =
  'Browse every free PDF tool: merge, split, extract pages, rotate, compress, Office to PDF, PDF to Word, Excel and images, OCR, watermark, page numbers, encrypt, unlock, redact, sign and fill forms. No signup, no watermark — limits are shown per tool.';
const TOOLS_INDEX_KEYWORDS =
  'all pdf tools, merge pdf online, split pdf pages, compress pdf free, convert pdf to word, pdf to excel, ocr online, unlock pdf without password, add watermark to pdf, esign pdf';

export function toolsIndexSeo(toolCount: number | null, tools?: ToolsIndexTool[]): SeoMeta {
  const count = toolCount && toolCount > 0 ? `${toolCount} ` : '';
  const url = canonicalFor('/tools');
  const jsonLd: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'All free PDF tools',
      url,
      inLanguage: 'en',
      description: TOOLS_INDEX_DESCRIPTION,
    },
  ];
  if (tools && tools.length > 0) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Free PDF tools',
      itemListElement: tools.map((tool, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: tool.title,
        description: tool.summary,
        url: canonicalFor(`/tools/${tool.id}`),
      })),
    });
  }
  return {
    title: `${TOOLS_INDEX_TITLE} (${count.trim() || 'PDF'}) | ${SITE_NAME}`,
    description: TOOLS_INDEX_DESCRIPTION,
    canonical: url,
    robots: 'index, follow, max-image-preview:large',
    ogType: 'website',
    keywords: TOOLS_INDEX_KEYWORDS,
    ogImage: ogImage(),
    jsonLd,
  };
}

export interface ToolSeoInput {
  id: string;
  title: string;
  summary: string;
  category: string;
  maxFiles?: number;
  extensions?: string[];
}

/** Search verbs per category — what people type when they need this kind of tool. */
const CATEGORY_KEYWORDS: Record<string, string> = {
  organize: 'merge pdf, combine pdf, split pdf, extract pages, reorder pages, rotate pdf, crop pdf',
  convert: 'pdf to word, pdf to excel, pdf to jpg, pdf to png, pdf to html, pdf to pdfa, office to pdf, images to pdf',
  optimize: 'compress pdf, reduce pdf size, repair pdf',
  edit: 'edit pdf, add text to pdf, watermark pdf, stamp pdf, page numbers, header footer pdf',
  security:
    'protect pdf, password protect pdf, encrypt pdf, unlock pdf, remove pdf password, redact pdf, sign pdf, esign pdf, fill pdf form',
  document: 'extract text from pdf, extract tables, pdf form data',
  ocr: 'ocr pdf, searchable pdf, scanned pdf to text',
};

function categoryKeywords(category: string): string {
  return CATEGORY_KEYWORDS[category] ?? `free pdf ${category} tool`;
}

export function toolSeo(tool: ToolSeoInput): SeoMeta {
  const path = `/tools/${tool.id}`;
  const url = canonicalFor(path);
  const fileWords = tool.maxFiles && tool.maxFiles > 1 ? `Upload up to ${tool.maxFiles} files` : 'Upload one document';
  const formats = tool.extensions && tool.extensions.length > 0 ? ` (${tool.extensions.join(', ').toUpperCase()})` : '';
  const description = `${tool.title}: ${tool.summary} Free online, no signup and no watermark. ${fileWords}${formats}, run the job in your browser session, and download before the file deletes itself.`;
  const steps = [
    `Upload your file${tool.maxFiles && tool.maxFiles > 1 ? 's' : ''} to ${tool.title}${formats}.`,
    'Choose the options shown for this tool.',
    'Run the job and download the result before it deletes itself.',
  ];
  return {
    title: `${tool.title} — Free Online | ${SITE_NAME}`,
    description,
    canonical: url,
    robots: 'index, follow, max-image-preview:large',
    ogType: 'article',
    keywords: `${tool.title.toLowerCase()}, ${categoryKeywords(tool.category)}, free, no signup, no watermark`,
    ogImage: ogImageFor(tool.id),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: tool.title,
        url,
        inLanguage: 'en',
        description,
        datePublished: SITE_CONTENT_DATE,
        dateModified: SITE_CONTENT_DATE,
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: canonicalFor('/') },
            { '@type': 'ListItem', position: 2, name: 'Tools', item: canonicalFor('/tools') },
            { '@type': 'ListItem', position: 3, name: tool.title, item: url },
          ],
        },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: tool.title,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web',
        url,
        description: tool.summary,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: canonicalFor('/') },
          { '@type': 'ListItem', position: 2, name: 'Tools', item: canonicalFor('/tools') },
          { '@type': 'ListItem', position: 3, name: tool.title, item: url },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'HowTo',
        name: `How to use ${tool.title}`,
        description,
        datePublished: SITE_CONTENT_DATE,
        step: steps.map((text, index) => ({
          '@type': 'HowToStep',
          position: index + 1,
          name: text,
          text,
        })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: `Is ${tool.title} free?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'Yes — every tool is free, with no signup and no watermark. Signed-in users get unlimited jobs; anonymous use is 15 jobs a day.',
            },
          },
          {
            '@type': 'Question',
            name: 'Are my files kept?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'No. Uploads and outputs are deleted automatically when the job expires; history keeps metadata only.',
            },
          },
          {
            '@type': 'Question',
            name: `Do I need to install anything to use ${tool.title}?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'No. The tool runs in your browser session — upload, run, and download, nothing to install.',
            },
          },
        ],
      },
    ],
  };
}

/** Private/app screens: crawlable URL but must not be indexed. */
export function noIndexSeo(path: string, title: string, description: string): SeoMeta {
  return {
    title: `${title} | ${SITE_NAME}`,
    description,
    canonical: canonicalFor(path),
    robots: 'noindex, nofollow',
    ogType: 'website',
    ogImage: ogImage(),
  };
}

/** The legacy `/pricing` URL: everything is free, so the page says exactly that instead of redirecting. */
export function pricingSeo(): SeoMeta {
  const url = canonicalFor('/pricing');
  return {
    title: `Pricing — Everything Is Free | ${SITE_NAME}`,
    description:
      'Rumindium PDF Tools has no plans and no paywall: every tool is free, with no signup and no watermark. Signed-in users get unlimited jobs; anonymous use is 15 jobs a day.',
    canonical: url,
    robots: 'index, follow, max-image-preview:large',
    ogType: 'website',
    keywords: 'pdf tools pricing, free pdf tools, no paywall',
    ogImage: ogImage(),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: 'Pricing — everything is free',
        url,
        inLanguage: 'en',
        description: 'Every tool is free, with no signup and no watermark.',
        datePublished: SITE_CONTENT_DATE,
        dateModified: SITE_CONTENT_DATE,
      },
    ],
  };
}
