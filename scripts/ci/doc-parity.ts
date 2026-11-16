/**
 * Compares every option surface the documents publish with the schema and the catalog.
 *
 * Thirteen per-tool reviews (`docs/0-E2E-CHECKLIST.md`) found the same defect over and over: a row of a
 * document's option table that no code ever read, a bound that was only a sentence, a default the document and
 * the contract disagreed about. The classes, with the counts: 20 table rows across five documents that the
 * `.strict()` schemas refuse — including `09-PDF-A.md`'s own request example, which its own API answered with a
 * 400 — eight options declared, defaulted and read by nobody, and fourteen bounds that existed in prose only.
 *
 * Every one of those was found by a person reading two files side by side, and nothing in the build ever asked
 * the question again. This is that question, mechanised: the documents are the product's most-read artefact, and
 * a document is a claim about the code — so it belongs in the build next to the claims that can fail.
 *
 * What it compares, per tool:
 *
 *   · **the option set** — every option the document names must exist in the schema (`option-not-in-schema`),
 *     and every schema option must be named by the document (`option-not-documented`, because an option nobody
 *     can discover is not shipped);
 *   · **the kind** — `bool` against `ZodBoolean`, `int`/`number` against `ZodNumber`, an alternative list
 *     against an enum, and so on, compared as *sets* of acceptable kinds so a document may write `int` for a
 *     bounded number without tripping on the word;
 *   · **the enum** — the alternatives a document lists against the values the schema accepts;
 *   · **the bounds** — a range a document states against the schema's `min`/`max`, for numbers and for string
 *     length (`1–200 characters`);
 *   · **the default** — a literal default against what the schema actually produces for `undefined`;
 *   · **the catalog limits** — the `Timeout` and `Memory` rows of a document's limits table against
 *     `limits.timeoutSeconds` / `limits.memoryMb`.
 *
 * What it deliberately does not do: parse prose. A bound that only appears in a sentence, a behaviour described
 * in a paragraph, a warning list — none of that is a cell, and guessing which sentence is a claim is how a check
 * starts producing failures nobody believes. The document side reads **option tables** and **TypeScript option
 * blocks** (`13-EDIT-AND-ANNOTATE.md` documents its three tools in `options: { … }` form, and saying so is
 * better than calling those tools unreviewable). Coverage is printed per tool, so a document that moves its
 * options into prose shows up as "not comparable" rather than as a silent pass.
 *
 * The documents live in the sibling `Auth-Platform` repository, so their absence is a **named gap** rather than
 * a failure (exit 3, `e2e/lib/stack-gap.ts`): a `pdf-tools`-only checkout must not go red because a different
 * repository is not on disk. Pass `--require-docs` where both are checked out — CI, and the way this ran here.
 *
 *   bun run doc:parity
 *   bun run doc:parity -- --require-docs
 *   bun run doc:parity -- --docs ../Auth-Platform/docs/13-integration/PDF-TOOLS
 *   bun run doc:parity -- --only watermark --only ocr
 *   bun run doc:parity -- --json e2e/artifacts/doc-parity.json
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TOOLS, type ToolDefinition, optionKeys, optionSchema } from '@pdftools/contracts';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Exit code for "could not run", matching the harness convention (`e2e/lib/stack-gap.ts`). */
const GAP_EXIT_CODE = 3;

/**
 * Which document publishes which tool's options.
 *
 * The map is asserted against the registry in both directions — every tool in `TOOLS` has to appear here
 * exactly once, and every file named here has to exist — so a new tool whose document nobody wrote, or a
 * document renamed out from under the map, fails this stage instead of quietly reducing its coverage. That
 * assertion is why the map is a literal and not a clever scan of the directory: "the document that describes
 * `pdf-to-pdfa` is `09-PDF-A.md`" is a fact worth writing down once.
 */
const DOC_TOOLS: Record<string, string[]> = {
  '01-MERGE.md': ['merge'],
  '02-SPLIT-AND-EXTRACT.md': ['split', 'extract-pages', 'delete-pages'],
  '03-ORGANIZE-ROTATE-CROP.md': ['reorder-pages', 'rotate', 'crop', 'n-up'],
  '04-COMPRESS.md': ['compress', 'remove-metadata', 'linearize'],
  '05-IMAGES-TO-PDF.md': ['images-to-pdf'],
  '06-PDF-TO-IMAGES.md': ['pdf-to-images'],
  '07-OFFICE-TO-PDF.md': ['office-to-pdf', 'html-to-pdf'],
  '08-PDF-TO-OFFICE-AND-TEXT.md': ['pdf-to-text', 'pdf-to-csv', 'pdf-to-html', 'pdf-to-office'],
  '09-PDF-A.md': ['pdf-to-pdfa'],
  '10-PROTECT-AND-UNLOCK.md': ['encrypt', 'restrict', 'unlock'],
  '11-WATERMARK.md': ['watermark'],
  '12-PAGE-NUMBERS-HEADERS-FOOTERS.md': ['page-numbers', 'header-footer'],
  '13-EDIT-AND-ANNOTATE.md': ['edit-pdf', 'annotate', 'redact'],
  '14-SIGN-AND-FORMS.md': ['sign', 'fill-form', 'extract-fields'],
  '15-OCR.md': ['ocr'],
};

// ─── the document side ────────────────────────────────────────────────────────────────────────────────────

export interface DocOption {
  key: string;
  source: 'table' | 'code-block';
  /** 1-based line in the document, for a message someone can act on. */
  line: number;
  /** The type/schema cell, when the source is a table. */
  typeCell?: string;
  defaultCell?: string;
  /** Everything after the type and default columns, which is where a bound is usually stated. */
  notesCell?: string;
  /**
   * The one tool a row of a **shared** table belongs to, when the row says so (`` `extract-pages` only ``).
   *
   * One heading may publish two tools that share a table (`### 3.2 \`extract-pages\` / \`delete-pages\``), and a
   * row may then belong to one of them: `mode` is `extract-pages`'s and `delete-pages` has never had it. The
   * marker is written the way the rest of these documents name an option or a tool — a backticked id — rather
   * than as an English qualifier, because the whole point of this stage is that a machine can read the claim.
   */
  owner?: string;
}

/**
 * The `###` scopes a tool's options may live in, as line ranges of the original file.
 *
 * Carrying the offset rather than the sliced text is what lets every finding name the line a reader can open
 * the file at; without it a message about `02-SPLIT-AND-EXTRACT.md:6` sends someone to the front matter of a
 * 280-line document.
 */
export interface Scope {
  lines: string[];
  /** Zero-based index of `lines[0]` in the document. */
  offset: number;
}

/**
 * `lines[index]`, or the empty string.
 *
 * This file reads text, where a line that is not there is a cell that is not there — never a crash. The repo
 * compiles with `noUncheckedIndexedAccess`, so every read of a line, a header cell or a capture group would
 * otherwise need its own guard, and the guards would bury the reading rules they sit inside.
 */
const at = (lines: string[], index: number): string => lines[index] ?? '';

/** `| a | b |` → `['a', 'b']`, with the escaped pipes markdown requires left alone. */
export function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isSeparatorRow = (line: string | undefined): boolean =>
  typeof line === 'string' && /^\|[\s:|-]+\|$/.test(line.trim());

/**
 * The tool a row of a shared table is reserved to, read from the `` `tool` only `` marker.
 *
 * Only ids that are tools of the document in question count, so a note that happens to hold a backticked word
 * (`\`extract-pages\` only` inside a table for two other tools) cannot silently drop a row from the comparison: an
 * unrecognised marker leaves the row shared, and a shared row that names another tool's option fails loudly.
 */
function ownerOf(cells: string[], toolIds: string[]): string | undefined {
  if (cells.length < 3) return undefined;
  for (const cell of cells.slice(1)) {
    const id = cell.match(/^`([a-z0-9-]+)`\s+only\b/i)?.[1];
    if (id !== undefined && toolIds.includes(id)) return id;
  }
  return undefined;
}

/** Strip the markdown a key may be wearing: `` `key` ``, `**key**`, `~~key~~`, `key[]`. */
const bareKey = (cell: string): string => cell.replace(/[*`~]/g, '').replace(/\[\]/g, '').replace(/\\/g, '').trim();

/**
 * The option keys a table cell names.
 *
 * A cell may hold one key (`` `fontSize` ``) or several (`` `tile.x`, `tile.y` ``), and reads better for it.
 * Keys are matched as identifier-shaped backticked tokens rather than by splitting on commas, so a cell that
 * also carries prose ("the shared range grammar, e.g. `pages`") cannot smuggle a word in.
 */
export function keysInCell(cell: string): string[] {
  const backticked = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  const candidates = backticked.length > 0 ? backticked : [cell];
  return candidates
    .map((candidate) => bareKey(candidate))
    .filter((candidate) => /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$/.test(candidate));
}

/**
 * Every option row in every option table of a document.
 *
 * An option table is recognised by its **header**, not its position: a markdown table whose first column is
 * `Option`. That is what keeps the corrections tables (`| § | Said | Is |`), the acceptance tables
 * (`| Case | … |`) and the planned-but-not-shipped tables (`| Option in the plan | State | Why |`) out of the
 * comparison — the last of those is the trap worth naming, because its first cell starts with the same word.
 */
export function parseOptionTables(lines: string[], offset = 0, toolIds: string[] = []): DocOption[] {
  const rows: DocOption[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!at(lines, i).startsWith('|') || !isSeparatorRow(lines[i + 1])) continue;

    const header = splitRow(at(lines, i)).map((cell) => bareKey(cell).toLowerCase());
    if (header[0] !== 'option') {
      // A table this stage does not read; skip its body so a cell inside it can never be read as a header.
      while (i + 1 < lines.length && at(lines, i + 1).startsWith('|')) i += 1;
      continue;
    }

    const typeColumn = header.findIndex((cell) => cell === 'type' || cell === 'schema');
    const defaultColumn = header.indexOf('default');
    const notesColumn = header.length - 1;
    i += 1; // the separator row

    while (i + 1 < lines.length && at(lines, i + 1).startsWith('|')) {
      i += 1;
      const cells = splitRow(at(lines, i));
      // A struck-through key is a **removal notice**, not an option: this is how `10-PROTECT-AND-UNLOCK.md`
      // records `keepPermissions`, which the plan listed and the contract deliberately does not have. Reading it
      // as a claim would fail the build for a document that is being honest about what it removed.
      if ((cells[0] ?? '').includes('~~')) continue;
      const keys = keysInCell(cells[0] ?? '');
      if (keys.length === 0) continue;
      const owner = ownerOf(cells, toolIds);
      for (const key of keys) {
        rows.push({
          key,
          source: 'table',
          line: i + 1 + offset,
          typeCell: typeColumn >= 0 ? (cells[typeColumn] ?? '') : undefined,
          defaultCell: defaultColumn >= 0 ? (cells[defaultColumn] ?? '') : undefined,
          notesCell:
            notesColumn > 0 && notesColumn !== typeColumn && notesColumn !== defaultColumn
              ? (cells[notesColumn] ?? '')
              : undefined,
          owner,
        });
      }
    }
  }

  return rows;
}

/**
 * Every option key named by an `options: { … }` TypeScript block.
 *
 * `13-EDIT-AND-ANNOTATE.md` documents three tools this way, and `14-SIGN-AND-FORMS.md` two of its three (the
 * third has a table), so this is not an edge case to be papered over. Only **top-level** keys are read — one
 * level of indentation deeper than `options:` — because the blocks nest element shapes inside their array
 * options (`elements: Array<{ page: number; x: number }>`) and those are properties of a value, not options.
 * A block carries no machine-readable bounds, so these keys are compared for **existence only**, and the
 * coverage line says so.
 */
export function parseOptionCodeBlocks(lines: string[], offset = 0): DocOption[] {
  const rows: DocOption[] = [];
  let inFence = false;
  let intro = '';

  for (let i = 0; i < lines.length; i += 1) {
    if (at(lines, i).startsWith('```')) {
      if (!inFence && /options:\s*\{/.test(lines[i + 1] ?? '') && /shipped/i.test(intro)) {
        rows.push(...keysOfBlock(lines, i + 1, offset));
      }
      inFence = !inFence;
      continue;
    }
    if (at(lines, i).trim() !== '') intro = at(lines, i);
  }

  // No block in this scope is labelled as the shipped one, so the blocks themselves are the surface.
  if (rows.length === 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (at(lines, i).startsWith('```') && /options:\s*\{/.test(lines[i + 1] ?? '')) {
        rows.push(...keysOfBlock(lines, i + 1, offset));
      }
    }
  }

  return rows;
}

/** The top-level keys of one `options: { … }` block, starting at the line that opens it. */
function keysOfBlock(lines: string[], openingIndex: number, offset: number): DocOption[] {
  const rows: DocOption[] = [];
  const opening = at(lines, openingIndex).match(/^(\s*)options:\s*\{/);
  if (!opening) return rows;
  const indentOfOpening = (opening[1] ?? '').length;
  const keyIndent = indentOfOpening + 2;
  const closingIndent = indentOfOpening;

  for (let j = openingIndex + 1; j < lines.length; j += 1) {
    const body = at(lines, j);
    if (body.startsWith('```')) break;
    const indent = (body.match(/^\s*/) ?? [''])[0]?.length ?? 0;
    if (body.trim() === '}' && indent === closingIndent) break;
    const field = body.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    if (!field) continue;
    const name = field[2];
    if ((field[1] ?? '').length !== keyIndent || name === undefined) continue;
    rows.push({ key: name, source: 'code-block', line: j + 1 + offset });
  }

  return rows;
}

/**
 * The tools a document must be read for, plus the slice of it that belongs to one tool.
 *
 * A document that publishes several tools separates them with `###` headings that name the tool in backticks
 * (`### 2.1 \`reorder-pages\``, `### \`page-numbers\``), and one heading may name two tools for a pair that
 * shares a table (`### 3.2 \`extract-pages\` / \`delete-pages\``). A single-tool document has no such
 * headings, so the whole file is its scope — which is also why the section *number* is never used: the options
 * live in §2 in most documents, in §3 in two of them, and a check that hard-coded "§2" would quietly compare
 * nothing at all after a document was restructured.
 */
export function scopeForTool(lines: string[], toolId: string, multiTool: boolean): Scope {
  if (!multiTool) return { lines, offset: 0 };

  const start = lines.findIndex((line) => /^###\s/.test(line) && line.includes(`\`${toolId}\``));
  if (start < 0) return { lines, offset: 0 };

  const level = ((at(lines, start).match(/^(#{1,6})\s/) as RegExpMatchArray)[1] ?? '').length;
  const end = lines.findIndex((line, index) => index > start && (line.match(/^(#{1,6})\s/)?.[1]?.length ?? 7) <= level);

  return { lines: lines.slice(start, end < 0 ? undefined : end), offset: start };
}

// ─── the schema side ──────────────────────────────────────────────────────────────────────────────────────

export type Kind = 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'object' | 'unknown';

export interface SchemaOption {
  key: string;
  kind: Kind;
  /** Accepted values, when the schema restricts them (`ZodEnum`, or a union of literals). */
  values?: string[];
  min?: number;
  max?: number;
  /** String length bounds, which a document states in prose far more often than a number bound. */
  minLength?: number;
  maxLength?: number;
  hasDefault: boolean;
  default?: unknown;
  optional: boolean;
}

/**
 * The schema's own account of one option, read through **public accessors**.
 *
 * `instanceof` is not available here: the schemas come from the workspace package and this script runs from the
 * repository root, where `zod` is not a resolvable dependency. Duck-typing on the constructor name and the
 * public getters (`minValue`, `options`, `unwrap`, `removeDefault`, `innerType`) is the version-proof way to do
 * it, and every accessor used here is documented API rather than `_def` internals — the same discipline
 * `optionKeys` follows for the reason its comment gives.
 *
 * The default is obtained by **parsing `undefined`**, not by reading a private field: a schema that answers
 * `undefined` with a value *is* a schema with a default, which is exactly the question the document's Default
 * column asks.
 */
export function describeSchema(key: string, field: unknown): SchemaOption {
  let current = field as Record<string, unknown>;
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown;

  for (let guard = 0; guard < 8; guard += 1) {
    const name = (current as { constructor?: { name?: string } })?.constructor?.name ?? '';
    if (name === 'ZodOptional' || name === 'ZodNullable') {
      optional = true;
      current = (current as { unwrap: () => Record<string, unknown> }).unwrap();
      continue;
    }
    if (name === 'ZodDefault') {
      const parsed = (current as { safeParse: (input: unknown) => { success: boolean; data?: unknown } }).safeParse(
        undefined,
      );
      if (parsed.success) {
        hasDefault = true;
        defaultValue = parsed.data;
      }
      current = (current as { removeDefault: () => Record<string, unknown> }).removeDefault();
      continue;
    }
    if (name === 'ZodEffects' && typeof current.innerType === 'function') {
      current = (current.innerType as () => Record<string, unknown>)();
      continue;
    }
    break;
  }

  const name = (current as { constructor?: { name?: string } })?.constructor?.name ?? '';
  const described: SchemaOption = { key, kind: 'unknown', hasDefault, default: defaultValue, optional };

  if (name === 'ZodBoolean') described.kind = 'boolean';
  else if (name === 'ZodNumber') {
    described.kind = 'number';
    described.min = typeof current.minValue === 'number' ? current.minValue : undefined;
    described.max = typeof current.maxValue === 'number' ? current.maxValue : undefined;
  } else if (name === 'ZodString') {
    described.kind = 'string';
    described.minLength = typeof current.minLength === 'number' ? current.minLength : undefined;
    described.maxLength = typeof current.maxLength === 'number' ? current.maxLength : undefined;
  } else if (name === 'ZodArray') described.kind = 'array';
  else if (name === 'ZodObject' || name === 'ZodRecord') described.kind = 'object';
  else if (name === 'ZodEnum') {
    described.kind = 'enum';
    described.values = (current.options as string[]).map(String);
  } else if (name === 'ZodNativeEnum') {
    described.kind = 'enum';
    described.values = Object.values(current.enum as Record<string, string>).map(String);
  } else if (name === 'ZodUnion' || name === 'ZodDiscriminatedUnion') {
    const members = current.options as Array<Record<string, unknown>>;
    const literals = members.filter((member) => member && member.constructor?.name === 'ZodLiteral');
    if (literals.length === members.length && literals.length > 0) {
      described.kind = 'enum';
      described.values = literals.map((literal) => String(literal.value));
    }
  }

  return described;
}

export function describeTool(tool: ToolDefinition): Map<string, SchemaOption> {
  const schemas = optionSchema(tool);
  const described = new Map<string, SchemaOption>();
  for (const key of optionKeys(tool)) described.set(key, describeSchema(key, schemas[key]));
  return described;
}

// ─── the document's claims, read off a row ────────────────────────────────────────────────────────────────

/** Normalise the dashes and minus signs a document may use for a range. */
const normalise = (text: string): string =>
  text
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '..')
    .replace(/\s+/g, ' ');

/** The acceptable schema kinds for the type words the documents actually use. */
const TYPE_WORDS: Record<string, Kind[]> = {
  bool: ['boolean'],
  boolean: ['boolean'],
  int: ['number'],
  integer: ['number'],
  number: ['number'],
  float: ['number'],
  string: ['string'],
  text: ['string'],
  hex: ['string'],
  color: ['string'],
  colour: ['string'],
  uuid: ['string'],
  password: ['string'],
  string_array: ['array'],
  array: ['array'],
  object: ['object'],
  json: ['object', 'array', 'string'],
};

export interface DocClaims {
  kinds?: Kind[];
  values?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  hasDefault: boolean;
}

const literal = (cell: string): { found: boolean; value?: unknown } => {
  const text = bareKey(cell).trim();
  if (text === '' || text === '-' || /^\(.*\)$/.test(text)) return { found: false };
  if (text === 'true') return { found: true, value: true };
  if (text === 'false') return { found: true, value: false };
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { found: true, value: Number(text) };
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return { found: true, value: text.toLowerCase() };
  return { found: false };
};

/**
 * A bare word in a Default cell, where it can only be compared when the schema itself closes the set.
 *
 * The documents write both kinds of thing in that column: a value (`2b`, `center`, `true`) and a description of
 * one (`all pages`, `upload order`, `auto-generated`, `see below`). Treating a description as a value would make
 * this stage fail on documents that are saying the right thing — `12-…FOOTERS.md`'s `pages` really does default
 * to "every page", and the schema says so by leaving the key optional. So a bare word is only read when the
 * schema restricts the option to a closed set (enum) or declares the same word as its own default; otherwise the
 * row is documentation and no comparison is invented from it.
 */
const wordLiteral = (cell: string, described: SchemaOption): { found: boolean; value?: unknown } => {
  const text = bareKey(cell).trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(text)) return { found: false };
  if (described.values?.some((value) => value.toLowerCase() === text.toLowerCase())) {
    return { found: true, value: text };
  }
  if (typeof described.default === 'string' && described.default.toLowerCase() === text.toLowerCase()) {
    return { found: true, value: text };
  }
  return { found: false };
};

const enumValuesIn = (cell: string): string[] | undefined => {
  if (!cell.includes('|') && !cell.includes('\\|')) return undefined;
  const parts = cell
    .split(/\\?\|/)
    .map((part) => bareKey(part).trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;
  if (!parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return undefined;
  return parts;
};

const RANGE = /(-?\d+(?:\.\d+)?)\s*(?:\.\.|-|to)\s*(-?\d+(?:\.\d+)?)/;
const LENGTHS = /(-?\d+)\s*(?:\.\.|-|to)\s*(-?\d+)\s+characters?/;

/**
 * What one row claims, and only where the claim is unambiguous.
 *
 * A bound is read from the type cell or from the start of the notes cell, or from a **bolded** range
 * (`` **10–90** ``) anywhere in it — the three spellings the documents actually use for a limit. A range buried
 * mid-sentence is *not* read: the watermark row for `tile` states its bound in a clause, and inventing a
 * comparison from it would make this check earn its first false positive.
 */
export function claimsFrom(option: DocOption, described: SchemaOption): DocClaims {
  const claims: DocClaims = { hasDefault: false };
  const type = normalise(option.typeCell ?? '');
  const rawType = option.typeCell ?? '';

  const values = enumValuesIn(rawType);
  if (values) claims.values = values;

  if (/\[\]/.test(rawType)) {
    // `uuid[]`, `string[][]`, `PageRange[]`: the brackets are the kind, and the word inside them is the element
    // type. Reading `string[]` as a string is what made the first run call every array option a mismatch.
    claims.kinds = ['array'];
  } else if (!values) {
    // Only when the cell is *not* an alternative list: in `` `text \| image` `` the members are words this
    // table does not define, and the kind the document is claiming is "one of these".
    const words = bareKey(type)
      .toLowerCase()
      .split(/[^a-z_]+/)
      .filter(Boolean);
    for (const word of words) {
      const kinds = TYPE_WORDS[word];
      if (kinds) claims.kinds = [...new Set([...(claims.kinds ?? []), ...kinds])];
    }
  }

  const search = [type, normalise(option.notesCell ?? '')].filter(Boolean).join(' · ');
  const leading = type.match(RANGE) ?? normalise(option.notesCell ?? '').match(new RegExp(`^\\s*${RANGE.source}`));
  // Normalised like the other two spellings: the documents write an en dash (`**10–90**`), and a regex that
  // only knew the hyphen read the bound as absent — so the one spelling this branch exists for was the one it
  // could not see.
  const bolded = normalise(option.notesCell ?? '').match(
    /\*\*\s*(-?\d+(?:\.\d+)?)\s*(?:\.\.|-)\s*(-?\d+(?:\.\d+)?)\s*\*\*/,
  );
  const lengths = search.match(LENGTHS);
  const range = leading ?? bolded;

  if (range) {
    claims.min = Number(range[1]);
    claims.max = Number(range[2]);
  }
  if (lengths) {
    claims.minLength = Number(lengths[1]);
    claims.maxLength = Number(lengths[2]);
  }

  const parsed = literal(option.defaultCell ?? '');
  if (parsed.found) {
    claims.hasDefault = true;
    claims.default = parsed.value;
  } else {
    const word = wordLiteral(option.defaultCell ?? '', described);
    if (word.found) {
      claims.hasDefault = true;
      claims.default = word.value;
    }
  }

  return claims;
}

/**
 * The `Timeout` and `Memory` rows of a document's limits table.
 *
 * Two rows only, and on purpose. Those are the two lines of a limits table that state a single number with a
 * unit, which is the whole of what can be compared without guessing; the pages and bytes rows are prose about
 * plan ceilings and pool behaviour, and a parser that tried to read them would be asserting its own reading of
 * an English sentence.
 */
export interface LimitClaim {
  label: 'Timeout' | 'Memory';
  seconds?: number;
  megabytes?: number;
  line: number;
}

const mentionsTool = (cell: string, toolId: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9-])${toolId.replace(/[-]/g, '\\-')}(?:$|[^a-z0-9-])`).test(cell);

/**
 * A limits table's `Timeout` and `Memory` rows for one tool.
 *
 * The documents spell a family's limits in all three shapes, and each one carries the tool's own number in a
 * different place:
 *
 *   · `| Limit | Value |` — one tool (or a shared number), in the second column;
 *   · `| Limit | \`split\` | \`extract-pages\` / \`delete-pages\` |` — one column per tool, which is how the
 *     family documents state four tools' timeouts in one table;
 *   · `| Timeout | 120 s (encrypt/restrict), 90 s (unlock) |` — one cell naming the tools it applies to.
 *
 * The third shape is the one that made the first run report a mismatch for `unlock` against its own
 * `encrypt` sibling's number, so the cell is split on commas and a segment that names no tool at all is only read
 * when no other segment names one — a number that belongs to somebody else is worse than no comparison.
 */
export function parseLimitClaims(
  lines: string[],
  toolId: string,
  offset = 0,
  registryIds: string[] = [],
): LimitClaim[] {
  const claims: LimitClaim[] = [];
  const ids = registryIds.length > 0 ? registryIds : [toolId];

  for (let i = 0; i < lines.length; i += 1) {
    if (!at(lines, i).startsWith('|') || !isSeparatorRow(lines[i + 1])) continue;
    const header = splitRow(at(lines, i));
    if (bareKey(header[0] ?? '').toLowerCase() !== 'limit') {
      while (i + 1 < lines.length && at(lines, i + 1).startsWith('|')) i += 1;
      continue;
    }

    const toolColumn = header.findIndex((cell, index) => index > 0 && mentionsTool(cell, toolId));
    i += 1;
    while (i + 1 < lines.length && at(lines, i + 1).startsWith('|')) {
      i += 1;
      const cells = splitRow(at(lines, i));
      const label = bareKey(cells[0] ?? '').toLowerCase();
      if (label !== 'timeout' && label !== 'memory') continue;
      const value = normalise(cells[toolColumn > 0 ? toolColumn : 1] ?? '');

      const segment = toolColumn > 0 ? value : valueForTool(value, toolId, ids);
      if (segment === undefined) continue;

      if (label === 'timeout') {
        const seconds = segment.match(/(\d+)\s*s\b/)?.[1];
        if (seconds) claims.push({ label: 'Timeout', seconds: Number(seconds), line: i + 1 + offset });
      } else {
        const megabytes = segment.match(/([\d\s]+)\s*MB/i)?.[1];
        if (megabytes) {
          claims.push({ label: 'Memory', megabytes: Number(megabytes.replace(/\s/g, '')), line: i + 1 + offset });
        }
      }
    }
  }

  return claims;
}

/**
 * The segment of a limits cell that belongs to `toolId`, if the cell names tools at all.
 *
 * The documents separate the per-tool numbers in one cell with all three of the punctuation marks a table cell has
 * room for: commas (`120 s (encrypt/restrict), 90 s (unlock)`), middle dots (`reorder-pages` 150 s · `rotate`
 * 120 s) and semicolons. Splitting on only one of them is how the first run read `linearize`'s timeout as
 * `compress`'s.
 */
function valueForTool(value: string, toolId: string, ids: string[]): string | undefined {
  const segments = value
    .split(/[,;·]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const named = segments.filter((segment) => ids.some((id) => mentionsTool(segment, id)));
  if (named.length === 0) return value;
  const mine = named.filter((segment) => mentionsTool(segment, toolId));
  return mine.length > 0 ? mine.join(', ') : undefined;
}

// ─── the comparison ───────────────────────────────────────────────────────────────────────────────────────

export type FindingKind =
  | 'doc-option-not-in-schema'
  | 'schema-option-not-documented'
  | 'kind-mismatch'
  | 'enum-mismatch'
  | 'range-mismatch'
  | 'length-mismatch'
  | 'default-mismatch'
  | 'limit-mismatch';

export interface Finding {
  tool: string;
  file: string;
  line?: number;
  key: string;
  kind: FindingKind;
  detail: string;
}

const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number'
    ? sameNumber(a, b)
    : typeof a === 'string' && typeof b === 'string'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;

const list = (values: unknown[]): string => values.map((value) => JSON.stringify(value)).join(' / ');

/** One tool: what the document says against what the schema accepts. */
export function compareTool(tool: ToolDefinition, file: string, docOptions: DocOption[]): Finding[] {
  const findings: Finding[] = [];
  const schema = describeTool(tool);
  const documented = new Map<string, DocOption>();

  for (const option of docOptions) {
    // A row reserved to a sibling tool is that tool's claim, not this one's.
    if (option.owner !== undefined && option.owner !== tool.id) continue;
    if (documented.has(option.key)) continue;
    documented.set(option.key, option);
    const described = schema.get(option.key);
    if (!described) {
      findings.push({
        tool: tool.id,
        file,
        line: option.line,
        key: option.key,
        kind: 'doc-option-not-in-schema',
        detail: `the document names \`${option.key}\` and the schema does not accept it`,
      });
      continue;
    }

    const claims = claimsFrom(option, described);
    if (option.source === 'code-block') continue; // keys only: a code block carries no machine-readable bounds

    const where = `\`${option.key}\``;
    if (claims.kinds && !claims.kinds.includes(described.kind)) {
      findings.push({
        tool: tool.id,
        file,
        line: option.line,
        key: option.key,
        kind: 'kind-mismatch',
        detail: `the document calls ${where} ${list(claims.kinds)} (${JSON.stringify(option.typeCell)}) and the schema is ${described.kind}`,
      });
    }
    if (claims.values) {
      const promised = [...claims.values].sort();
      const accepted = [...(described.values ?? [])].sort();
      if (accepted.length === 0) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'enum-mismatch',
          detail: `the document offers a closed set for ${where} (${list(claims.values)}) and the schema accepts anything (${described.kind})`,
        });
      } else if (promised.join(',') !== accepted.join(',')) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'enum-mismatch',
          detail: `the document offers ${list(claims.values)} for ${where} and the schema accepts ${list(accepted)}`,
        });
      }
    }

    if (claims.min !== undefined && claims.max !== undefined) {
      if (typeof described.min === 'number' && typeof described.max === 'number') {
        if (!sameNumber(claims.min, described.min) || !sameNumber(claims.max, described.max)) {
          findings.push({
            tool: tool.id,
            file,
            line: option.line,
            key: option.key,
            kind: 'range-mismatch',
            detail: `the document bounds ${where} to ${claims.min}-${claims.max} and the schema bounds it to ${described.min}-${described.max}`,
          });
        }
      } else if (described.kind === 'number') {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'range-mismatch',
          detail: `the document bounds ${where} to ${claims.min}-${claims.max} and the schema accepts ${described.min ?? 'anything'} - ${described.max ?? 'anything'}`,
        });
      }
    }

    if (claims.minLength !== undefined && claims.maxLength !== undefined) {
      const enforced = typeof described.maxLength === 'number';
      if (!enforced) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'length-mismatch',
          detail: `the document bounds ${where} to ${claims.minLength}-${claims.maxLength} characters and the schema does not measure its length`,
        });
      } else if (
        !sameNumber(claims.maxLength, described.maxLength as number) ||
        (typeof described.minLength === 'number' && !sameNumber(claims.minLength, described.minLength))
      ) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'length-mismatch',
          detail: `the document bounds ${where} to ${claims.minLength}-${claims.maxLength} characters and the schema bounds it to ${described.minLength ?? 0}-${described.maxLength}`,
        });
      }
    }

    if (claims.hasDefault) {
      if (!described.hasDefault) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'default-mismatch',
          detail: `the document gives ${where} the default ${JSON.stringify(claims.default)} and the schema has none (${described.optional ? 'optional' : 'required'})`,
        });
      } else if (!sameValue(claims.default, described.default)) {
        findings.push({
          tool: tool.id,
          file,
          line: option.line,
          key: option.key,
          kind: 'default-mismatch',
          detail: `the document defaults ${where} to ${JSON.stringify(claims.default)} and the schema defaults it to ${JSON.stringify(described.default)}`,
        });
      }
    }
  }

  for (const [key, described] of schema) {
    if (documented.has(key)) continue;
    findings.push({
      tool: tool.id,
      file,
      key,
      kind: 'schema-option-not-documented',
      detail: `${tool.id} accepts \`${key}\` (${described.kind}) and the document does not name it — an option nobody can discover is not shipped`,
    });
  }

  return findings;
}

// ─── driving it ───────────────────────────────────────────────────────────────────────────────────────────

interface Options {
  docs: string;
  requireDocs: boolean;
  json?: string;
  only: string[];
}

/** What one run of the comparison found, in the order the report lists it. */
export interface CheckResult {
  tools: Report['tools'];
  findings: Finding[];
  mapErrors: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    docs: process.env.PDFTOOLS_DOCS ?? resolve(ROOT, '../Auth-Platform/docs/13-integration/PDF-TOOLS'),
    requireDocs: false,
    only: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--docs') options.docs = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--require-docs') options.requireDocs = true;
    else if (arg === '--json') options.json = argv[++i];
    else if (arg === '--only') options.only.push(argv[++i] ?? '');
  }
  return options;
}

type Coverage = 'table' | 'code-block' | 'both' | 'none';

interface Report {
  docs: string;
  tools: Array<{
    tool: string;
    file: string;
    coverage: Coverage;
    documented: number;
    accepted: number;
  }>;
  findings: Finding[];
  mapErrors: string[];
}

/**
 * The whole comparison, without the printing.
 *
 * Split out from `main` so a test can run **this** against a document tree instead of re-implementing it, and so
 * the failing path can be exercised on purpose: a check that has never been seen to fail is a check nobody knows
 * the shape of. `scripts/ci/doc-parity.docs.test.ts` mutates one row of a copy of the real documents and asserts
 * the finding that comes back, which is the only evidence that the rows this stage compares are the rows that
 * matter.
 */
export async function checkDocuments(docs: string, only: string[] = []): Promise<CheckResult> {
  // The map's own invariants first: a tool with no document, or two documents for one tool, would make the
  // coverage below a smaller number without saying so.
  const mapErrors: string[] = [];
  const seen = new Map<string, string>();
  for (const [file, tools] of Object.entries(DOC_TOOLS)) {
    if (!existsSync(join(docs, file))) mapErrors.push(`${file} is named by the map and not on disk`);
    for (const tool of tools) {
      if (seen.has(tool)) mapErrors.push(`${tool} is mapped to both ${seen.get(tool)} and ${file}`);
      seen.set(tool, file);
    }
  }
  for (const tool of TOOLS) {
    if (!seen.has(tool.id)) mapErrors.push(`${tool.id} is in the registry and in no document`);
  }

  const files = new Map<string, string[]>();
  for (const file of new Set(
    Object.values(DOC_TOOLS)
      .flat()
      .map((tool) => seen.get(tool) as string),
  )) {
    try {
      files.set(file, (await readFile(join(docs, file), 'utf8')).split('\n'));
    } catch (error) {
      // A document the map names and the directory does not hold is the map error above, not a stack trace: the
      // tool's tools are simply not compared, and the run still prints every *other* tool's verdict. Throwing
      // here would replace fifteen missing-file lines with one ENOENT and lose the four findings that matter.
      const reason = error instanceof Error ? error.message : String(error);
      if (!mapErrors.some((entry) => entry.startsWith(`${file} `))) {
        mapErrors.push(`${file} could not be read — ${reason}`);
      }
    }
  }

  const findings: Finding[] = [];
  const tools: Report['tools'] = [];
  const registryIds = TOOLS.map((tool) => tool.id);

  for (const tool of TOOLS) {
    if (only.length > 0 && !only.includes(tool.id)) continue;
    const file = seen.get(tool.id);
    if (!file) continue;
    const lines = files.get(file);
    if (!lines) continue; // already reported as a map error
    const multiTool = (DOC_TOOLS[file] ?? []).length > 1;
    const scope = scopeForTool(lines, tool.id, multiTool);

    const table = parseOptionTables(scope.lines, scope.offset, DOC_TOOLS[file] ?? []);
    const code = parseOptionCodeBlocks(scope.lines, scope.offset);
    const docOptions = [...table, ...code];
    const coverage: Coverage =
      table.length > 0 && code.length > 0
        ? 'both'
        : table.length > 0
          ? 'table'
          : code.length > 0
            ? 'code-block'
            : 'none';

    // Counted the way the comparison reads them: a row reserved to a sibling tool is that tool's, so `delete-pages`
    // does not report `mode` among its documented options. Without that filter the printed "2 documented · 1 in the
    // schema" was a coverage line disagreeing with the verdict beside it.
    const mine = docOptions.filter((option) => option.owner === undefined || option.owner === tool.id);
    tools.push({
      tool: tool.id,
      file,
      coverage,
      documented: new Set(mine.map((option) => option.key)).size,
      accepted: optionKeys(tool).length,
    });

    if (coverage === 'none') {
      findings.push({
        tool: tool.id,
        file,
        key: '—',
        kind: 'schema-option-not-documented',
        detail: `${tool.id} accepts ${optionKeys(tool).length} option(s) and ${file} publishes none in a form this check can read (an option table or an \`options:\` block)`,
      });
      continue;
    }

    findings.push(...compareTool(tool, file, mine));

    // The limits table is read off the whole document: it is one table per document, not one per tool, and
    // two tools sharing it is the reason `12-…FOOTERS.md` states both tools' font sizes in one row.
    for (const claim of parseLimitClaims(multiTool ? lines : scope.lines, tool.id, 0, registryIds)) {
      if (claim.seconds !== undefined && claim.seconds !== tool.limits.timeoutSeconds) {
        findings.push({
          tool: tool.id,
          file,
          line: claim.line,
          key: 'limits.timeoutSeconds',
          kind: 'limit-mismatch',
          detail: `the document's limits table says Timeout ${claim.seconds} s and the catalog gives ${tool.id} ${tool.limits.timeoutSeconds} s`,
        });
      }
      if (claim.megabytes !== undefined && claim.megabytes !== tool.limits.memoryMb) {
        findings.push({
          tool: tool.id,
          file,
          line: claim.line,
          key: 'limits.memoryMb',
          kind: 'limit-mismatch',
          detail: `the document's limits table says Memory ${claim.megabytes} MB and the catalog gives ${tool.id} ${tool.limits.memoryMb} MB`,
        });
      }
    }
  }

  return { tools, findings, mapErrors };
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));

  console.log(`doc parity → ${options.docs}`);

  if (!existsSync(options.docs)) {
    const reason = `the PDF-TOOLS documents are not on disk at ${options.docs}`;
    if (options.requireDocs) {
      console.error(`  ✗ ${reason}, and --require-docs was passed`);
      process.exit(1);
    }
    console.log(`  · not run — STACK GAP: ${reason}`);
    console.log('    pass --docs <dir>, set PDFTOOLS_DOCS, or run where both repositories are checked out');
    process.exit(GAP_EXIT_CODE);
  }

  const { tools, findings, mapErrors } = await checkDocuments(options.docs, options.only);

  for (const tool of tools) {
    const mark = findings.some((finding) => finding.tool === tool.tool) ? '✗' : '✓';
    const coverage =
      tool.coverage === 'both'
        ? 'table + code block'
        : tool.coverage === 'table'
          ? 'option table'
          : tool.coverage === 'code-block'
            ? 'options block (keys only)'
            : 'nothing readable';
    console.log(
      `  ${mark} ${tool.tool.padEnd(16)} ${tool.file.padEnd(34)} ${String(tool.documented).padStart(2)} documented · ${String(tool.accepted).padStart(2)} in the schema · ${coverage}`,
    );
  }

  if (mapErrors.length > 0) {
    console.log('\nthe document map:');
    for (const error of mapErrors) console.log(`  ✗ ${error}`);
  }

  if (findings.length > 0) {
    console.log('\nfindings:');
    for (const finding of findings) {
      const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.log(`  ✗ ${finding.tool} ${where} [${finding.kind}]`);
      console.log(`      ${finding.detail}`);
    }
  }

  if (options.json) {
    const report: Report = { docs: options.docs, tools, findings, mapErrors };
    await mkdir(dirname(options.json), { recursive: true });
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport: ${resolve(options.json)}`);
  }

  const byTable = tools.filter((tool) => tool.coverage === 'table' || tool.coverage === 'both').length;
  const byCode = tools.filter((tool) => tool.coverage === 'code-block').length;
  const failed = findings.length + mapErrors.length;

  if (failed > 0) {
    console.error(
      `\ndoc parity failed — ${findings.length} finding(s) and ${mapErrors.length} map error(s) across ${tools.length} tool(s)`,
    );
    process.exit(1);
  }

  console.log(
    `\ndoc parity passed — ${tools.length} tool(s) agree with their documents (${byTable} by option table, ${byCode} by options block)`,
  );
}

if (import.meta.main) await main();
