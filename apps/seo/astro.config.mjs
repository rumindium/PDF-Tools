// Astro SEO site: fully static (SSG) marketing + tool pages.
// The interactive app stays the Vite SPA; this site is the crawler-first
// layer (/, /tools, /tools/[id], /pricing) served from the same origin.
import { defineConfig } from 'astro/config';

const SITE_URL = process.env.SEO_SITE_URL ?? 'https://pdf.rumindium.id';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  // No sitemap integration on purpose: the served sitemap is the registry-driven `apps/web/public/sitemap.xml`
  // (`bun run seo:sitemap`), and a second generator here only produced an unserved, unlinked copy in the snapshot
  // dir.
  build: { inlineStylesheets: 'auto' },
});
