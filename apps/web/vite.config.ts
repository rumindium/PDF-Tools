import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/**
 * Web build (`docs/0-FOLDER-STRUCTURE.md` §3).
 *
 * In development every `/api` and `/health` call is proxied to the API on the same origin, so the anonymous
 * session cookie is first-party and `credentials: 'include'` works without a CORS preflight for each request.
 * In production Caddy / nginx serves this bundle and proxies the same two prefixes, so the app never needs to
 * know the API's origin — which is also why no access token ever has to live in browser storage.
 */
const apiTarget = process.env.VITE_API_PROXY ?? 'http://localhost:8080';

/**
 * The id of **this build**, stamped into both the bundle and the `index.html` it is served with.
 *
 * One id per build rather than a content hash of the entry chunk, because what the check is asking is "was this tab built
 * from the same build as the page the server is serving", not "is this file the same file". A rebuild that changes one
 * component must produce a different id even when the entry chunk happens to come out byte-identical, and a rebuild that
 * changes nothing still counts as a deploy — `VITE_BUILD_ID` is the escape hatch for a reproducible build.
 */
const buildId = process.env.VITE_BUILD_ID ?? Date.now().toString(36);

/** Stamp the id into the served page, so a tab can compare its own build against the server's (`lib/build-id.ts`). */
function buildIdPlugin(): Plugin {
  return {
    name: 'pdftools-build-id',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          '    <meta name="color-scheme" content="light dark" />',
          `    <meta name="color-scheme" content="light dark" />\n    <meta name="build-id" content="${buildId}" />`,
        ),
    },
  };
}

export default defineConfig({
  plugins: [react(), buildIdPlugin()],
  // Replaced at build time in the bundle too, so the running screens and the served page carry the same string — and the
  // comparison never has to ask the API for anything.
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    // Production nginx mirrors these prefixes; the local production preview must too.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Route-level lazy loading keeps the initial bundle small; a chunk per heavy screen is intentional
    // (spec §14, §30).
    chunkSizeWarningLimit: 700,
  },
});
