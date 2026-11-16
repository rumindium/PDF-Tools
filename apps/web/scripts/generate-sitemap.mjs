// Generates apps/web/public/sitemap.xml from the tool registry.
// Run with: bun run seo:sitemap (also runs automatically before `build`).
import { TOOLS } from '@pdftools/contracts/tools';

const SITE_URL = process.env.SEO_SITE_URL ?? 'https://pdf.rumindium.id';
const today = new Date().toISOString().slice(0, 10);

const staticRoutes = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/tools', changefreq: 'daily', priority: '0.9' },
];

// Indonesian twins (`apps/seo/src/pages/id/`, S3): home, tools index, and the six translated tools. Only built
// pages are listed — an hreflang and a sitemap entry must never name a URL that does not exist.
const ID_TOOL_IDS = ['merge', 'split', 'compress', 'pdf-to-office', 'pdf-to-images', 'ocr'];

const toolRoutes = TOOLS.filter((tool) => tool.enabled !== false).map((tool) => ({
  path: `/tools/${tool.id}`,
  changefreq: 'weekly',
  priority: '0.8',
}));

const idRoutes = [
  { path: '/id', changefreq: 'daily', priority: '0.9' },
  { path: '/id/tools', changefreq: 'daily', priority: '0.8' },
  ...TOOLS.filter((tool) => ID_TOOL_IDS.includes(tool.id)).map((tool) => ({
    path: `/id/tools/${tool.id}`,
    changefreq: 'weekly',
    priority: '0.8',
  })),
];

const urls = [...staticRoutes, ...toolRoutes, ...idRoutes]
  .map(
    (route) =>
      `  <url>\n    <loc>${SITE_URL}${route.path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${route.changefreq}</changefreq>\n    <priority>${route.priority}</priority>\n  </url>`,
  )
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

const out = new URL('../public/sitemap.xml', import.meta.url);
await Bun.write(out, `${xml}`);
console.log(`sitemap: wrote ${staticRoutes.length + toolRoutes.length + idRoutes.length} urls to public/sitemap.xml`);
