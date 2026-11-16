/// <reference types="vite/client" />

/**
 * Only two variables are read by the browser bundle, and neither is a secret.
 *
 * The API origin is intentionally *not* configurable at runtime: the bundle talks to `/api` on its own origin and
 * the reverse proxy decides where that goes. A build-time API URL in a browser bundle is how a token ends up in
 * `localStorage` "because CORS was easier that way".
 */
interface ImportMetaEnv {
  /** Base path for the API when it is not served under `/api` on the same origin. Defaults to `/api`. */
  readonly VITE_API_URL?: string;
  /** Optional label shown in the footer, e.g. the workspace name. */
  readonly VITE_APP_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The id of the build this bundle was compiled from, replaced at build time by `vite.config.ts`.
 *
 * A `define` rather than an env var on purpose: it is not configuration — nobody sets it, and setting it wrong would
 * make the stale-bundle check wrong (`lib/build-id.ts`). The same value is stamped into the served `index.html`.
 */
declare const __BUILD_ID__: string;
