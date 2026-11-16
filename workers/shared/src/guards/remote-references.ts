/**
 * What an HTML document asks the renderer to *fetch* — and whether this product is willing to fetch it.
 *
 * This exists because the fetch is real, which was measured before the guard was written: a document with
 * `<img src="http://127.0.0.1:9911/x.png">` produced a *request* from inside the office container during
 * `--convert-to pdf`, while a `.docx` with an external image relationship and one with an `INCLUDEPICTURE` field
 * produced none. So the egress vector is the HTML path, and the guard belongs there rather than at every input.
 *
 * The product never fetches, by design (`docs/0-SECURITY.md` §7: an engine that cannot reach the network cannot
 * exfiltrate a document or be used as a request proxy). The engine reaching for a URL therefore has three possible
 * outcomes in a stack where egress is closed, and only one of them is honest:
 *
 *   1. the fetch fails silently and the document loses the image — the user is told nothing, and the output is a
 *      partial rendering presented as a whole one;
 *   2. the reference resolves to something *inside* the container — a `file://` or absolute path would read a file
 *      the caller never uploaded, which is the one outcome worth lying awake about;
 *   3. the job is refused and names what it cannot honour.
 *
 * A fourth path — "fetch it, it is only an image" — is what the tool did until this guard existed, and it is the
 * request-proxy behaviour the security section says does not happen. So relative references only, and the ones that
 * are not relative come back to the caller in the failure message.
 *
 * Two details are deliberate. **`<a href>` is not a reference**: a hyperlink is not fetched to render a page, and
 * refusing a document because it contains a link would break perfectly ordinary HTML. **`data:` is not a
 * reference**: it carries its bytes with it, so there is nothing to fetch.
 */

export interface RemoteReference {
  /** The reference as written in the document. */
  reference: string;
  /** Where it was found — `img src`, `link href`, `style url(...)` — so the message can point at it. */
  where: string;
  /** Why it cannot be honoured. */
  reason: 'external' | 'absolute' | 'traversal';
}

/** A tag, with attribute values allowed to contain `>` (which a naive `<[^>]*>` gets wrong). */
const TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi;

/**
 * Attributes the renderer resolves while *drawing*. `href` is absent on purpose except for `<link>`, where it
 * names a stylesheet (which is fetched) rather than a navigation target (which is not).
 */
const FETCHED_ATTRIBUTES: Record<string, string[]> = {
  img: ['src', 'srcset', 'longdesc'],
  link: ['href'],
  script: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  source: ['src', 'srcset'],
  track: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  input: ['src'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  '*': ['style'],
};

/** Every reference in an HTML document that the renderer would have to fetch. */
export function findRemoteReferencesInHtml(html: string): RemoteReference[] {
  const found: RemoteReference[] = [];

  TAG.lastIndex = 0;
  let tag: RegExpExecArray | null = TAG.exec(html);
  while (tag !== null) {
    const element = (tag[1] ?? '').toLowerCase();
    const raw = tag[2] ?? '';
    const attributes = new Map<string, string>();
    ATTRIBUTE.lastIndex = 0;
    let attribute: RegExpExecArray | null = ATTRIBUTE.exec(raw);
    while (attribute !== null) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      attributes.set((attribute[1] ?? '').toLowerCase(), value);
      attribute = ATTRIBUTE.exec(raw);
    }

    const names = [...(FETCHED_ATTRIBUTES[element] ?? []), ...(FETCHED_ATTRIBUTES['*'] ?? [])];
    for (const name of names) {
      const value = attributes.get(name);
      if (value === undefined) continue;
      if (name === 'srcset') {
        // A candidate list: `a.png 1x, b.png 2x`. Each URL is judged on its own, and the descriptor is not one.
        for (const candidate of value.split(',')) {
          const url = (candidate.trim().split(/\s+/)[0] ?? '').trim();
          if (url !== '') collect(found, url, `${element} ${name}`);
        }
        continue;
      }
      if (name === 'style') {
        found.push(...findRemoteReferencesInCss(value, `${element} style`));
        continue;
      }
      collect(found, value, `${element} ${name}`);
    }

    tag = TAG.exec(html);
  }

  // Inline stylesheets, which is where a website export keeps its background images and its font imports.
  STYLE_BLOCK.lastIndex = 0;
  let block: RegExpExecArray | null = STYLE_BLOCK.exec(html);
  while (block !== null) {
    found.push(...findRemoteReferencesInCss(block[1] ?? '', 'inline <style>'));
    block = STYLE_BLOCK.exec(html);
  }

  return dedupe(found);
}

/** Every reference in a stylesheet that the renderer would have to fetch. */
export function findRemoteReferencesInCss(css: string, where = 'stylesheet'): RemoteReference[] {
  const found: RemoteReference[] = [];

  CSS_URL.lastIndex = 0;
  let url: RegExpExecArray | null = CSS_URL.exec(css);
  while (url !== null) {
    collect(found, (url[1] ?? url[2] ?? url[3] ?? '').trim(), `${where} url(…)`);
    url = CSS_URL.exec(css);
  }

  CSS_IMPORT.lastIndex = 0;
  let imported: RegExpExecArray | null = CSS_IMPORT.exec(css);
  while (imported !== null) {
    collect(found, (imported[1] ?? imported[2] ?? imported[3] ?? '').trim(), `${where} @import`);
    imported = CSS_IMPORT.exec(css);
  }

  return dedupe(found);
}

/**
 * The rule, in one place so the HTML walker and the stylesheet walker cannot disagree: a reference is honourable
 * when it travels with the document (`data:`, a fragment) or resolves to a file *beside* it.
 */
function collect(found: RemoteReference[], reference: string, where: string): void {
  const value = reference.trim();
  if (value === '' || value.startsWith('#')) return;
  // Bytes that travel with the document are not a fetch.
  if (/^data:/i.test(value)) return;
  // Any scheme at all: `http`, `https`, `ftp`, `file`, and whatever comes next.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    found.push({ reference: value, where, reason: 'external' });
    return;
  }
  // Protocol-relative, which is external with the scheme left off.
  if (value.startsWith('//')) {
    found.push({ reference: value, where, reason: 'external' });
    return;
  }
  // A filesystem path rather than a document path. The engine runs as its own user inside the job directory; an
  // absolute reference is how a document asks for something that was never uploaded.
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    found.push({ reference: value, where, reason: 'absolute' });
    return;
  }
  const segments = value.split(/[\\/]/);
  if (segments.includes('..')) {
    found.push({ reference: value, where, reason: 'traversal' });
  }
}

function dedupe(found: RemoteReference[]): RemoteReference[] {
  const seen = new Set<string>();
  const unique: RemoteReference[] = [];
  for (const entry of found) {
    const key = `${entry.reason}\u0000${entry.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

/**
 * The failure message: what was found, where, and what the caller does about it.
 *
 * It names the first reference and the locations of the rest rather than dumping every URL — a document exported
 * from a website can carry dozens, and a message that lists forty URLs is one nobody reads.
 */
export function describeRemoteReferences(found: RemoteReference[]): string {
  const first = found[0]!;
  const reason =
    first.reason === 'external'
      ? 'points at the network, which this converter never uses'
      : first.reason === 'absolute'
        ? 'points at an absolute path, which is not part of the document'
        : 'walks out of the document directory';
  const rest = found.length > 1 ? ` (${found.length - 1} more reference(s) in the same document)` : '';
  return `The document reference "${first.reference}" (${first.where}) ${reason}${rest}. Reference a file relative to the HTML — put the asset beside it, or include it in the bundle — and submit again.`;
}
