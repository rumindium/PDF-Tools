// Renders per-tool OG covers (1200×630) by screenshotting `og-cover.html` with query params.
//
//   bun run seo:og
//
// Uses the system Chrome in headless-screenshot mode — no new dependencies, no external service. Output is
// committed (`public/og/*.png`, like the shared `og-cover.png`) because unfurl crawlers fetch the image from the
// deployed origin and a build-time render would need a browser in the Docker build.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, '..', 'public', 'og');
mkdirSync(outDir, { recursive: true });

// The five highest-traffic tools: a tool-specific unfurl beats the generic cover, and five images stay small
// enough to version. Any other tool falls back to `og-cover.png` (`lib/seo.ts` `ogImageFor`).
const TOOLS = [
  { id: 'merge', title: 'Merge PDF', sub: 'Combine several PDFs into one document — free, no signup, no watermark.' },
  {
    id: 'split',
    title: 'Split PDF',
    sub: 'Extract the pages you need into new files — free, no signup, no watermark.',
  },
  {
    id: 'compress',
    title: 'Compress PDF',
    sub: 'Shrink a PDF for sharing without hurting reading — free, no watermark.',
  },
  {
    id: 'pdf-to-office',
    title: 'PDF to Word',
    sub: 'Turn a PDF into an editable Word document — free, no signup, no watermark.',
  },
  { id: 'ocr', title: 'OCR PDF', sub: 'Make a scanned PDF searchable and selectable — free, no signup, no watermark.' },
];

for (const tool of TOOLS) {
  const params = new URLSearchParams({
    title: tool.title,
    sub: tool.sub,
    chips: 'All tools free,No install,No watermark',
  });
  const url = `file://${join(root, 'og-cover.html')}?${params.toString()}`;
  const out = join(outDir, `${tool.id}.png`);
  const proc = Bun.spawnSync([
    'google-chrome',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1200,630',
    `--screenshot=${out}`,
    url,
  ]);
  if (proc.exitCode !== 0) {
    console.error(`og: chrome failed for ${tool.id}:\n${proc.stderr.toString()}`);
    process.exit(1);
  }
  console.log(`og: wrote public/og/${tool.id}.png`);
}
