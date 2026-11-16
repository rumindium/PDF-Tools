import { describe, expect, test } from 'bun:test';
import { TOOLS, type ToolDefinition, optionSchema } from '@pdftools/contracts';
import {
  type DocOption,
  type Kind,
  type SchemaOption,
  claimsFrom,
  compareTool,
  describeSchema,
  describeTool,
  keysInCell,
  parseLimitClaims,
  parseOptionCodeBlocks,
  parseOptionTables,
  scopeForTool,
  splitRow,
} from './doc-parity';

/**
 * The parser and the comparison rules of `bun run doc:parity`.
 *
 * A check whose whole job is to fail when a document and a schema disagree has one way to be useless: failing for
 * the wrong reason. Its first run over the fifteen documents produced 70 findings, of which **59 were its own
 * reading of the documents** — a `string[]` cell reported as a string kind, one shared table's `mode` attributed
 * to a tool that never had it, `linearize` read off `compress`'s number in a comma-separated cell, and a
 * description in a Default column ("all pages") compared as if it were a value. Every one of those mistakes is a
 * test here, named after the thing it prevents, so the next person to touch the parser finds out from a failing
 * test rather than from a list of findings nobody believes.
 *
 * The comparisons are exercised against the **real** watermark schema rather than a hand-written stand-in: the
 * rows that pass are generated from the schema, and each mismatch test changes exactly one cell of those rows, so
 * a failure says which cell and which rule.
 */

const tool = (id: string): ToolDefinition => {
  const found = TOOLS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no tool ${id} in the registry`);
  return found;
};

const watermark = tool('watermark');
const watermarkSchema = describeTool(watermark);

const field = (key: string): SchemaOption => {
  const described = watermarkSchema.get(key);
  if (!described) throw new Error(`watermark has no option ${key}`);
  return described;
};

/** The type word a document would use for each schema kind — the map the comparison is meant to accept. */
const TYPE_WORD: Record<Kind, string> = {
  boolean: 'bool',
  number: 'int',
  string: 'string',
  enum: 'enum',
  array: 'string[]',
  object: 'object',
  unknown: 'json',
};

/**
 * The rows a document would write if it agreed with the schema, one per option.
 *
 * Generated rather than transcribed on purpose: transcribing 14 rows by hand would test my reading of the
 * document, which is the thing this file exists to distrust. Bounds are stated only when the schema states both
 * ends — a one-sided bound is not a claim `claimsFrom` reads, and the point of these rows is to claim everything
 * the schema can be asked about.
 */
function agreeingRows(described: Map<string, SchemaOption>): DocOption[] {
  const rows: DocOption[] = [];
  for (const [key, option] of described) {
    const typeCell = option.kind === 'enum' ? (option.values ?? []).join(' \\| ') : TYPE_WORD[option.kind];
    const notes: string[] = [];
    if (option.kind === 'number' && typeof option.min === 'number' && typeof option.max === 'number') {
      notes.push(`${option.min}–${option.max}`);
    }
    if (typeof option.maxLength === 'number' && typeof option.minLength === 'number') {
      notes.push(`${option.minLength}–${option.maxLength} characters`);
    }
    rows.push({
      key,
      source: 'table',
      line: 1,
      typeCell,
      defaultCell: option.hasDefault ? `\`${String(option.default)}\`` : undefined,
      notesCell: notes.length > 0 ? notes.join('; ') : undefined,
    });
  }
  return rows;
}

const agreed = agreeingRows(watermarkSchema);
const replace = (key: string, over: Partial<DocOption>): DocOption[] =>
  agreed.map((row) => (row.key === key ? { ...row, ...over } : row));
const kindsOf = (findings: ReturnType<typeof compareTool>): string[] =>
  findings.map((finding) => `${finding.kind}:${finding.key}`).sort();

const lines = (text: string): string[] => text.split('\n');

describe('reading a markdown row', () => {
  test('an escaped pipe stays inside its cell', () => {
    expect(splitRow('| `a \\| b` | `x` |')).toEqual(['`a \\| b`', '`x`']);
  });

  test('a key cell may name one key, several keys, or none', () => {
    expect(keysInCell('`fontSize`')).toEqual(['fontSize']);
    expect(keysInCell('`tile.x`, `tile.y`')).toEqual(['tile.x', 'tile.y']);
    expect(keysInCell('the shared range grammar')).toEqual([]);
  });
});

describe('option tables', () => {
  const table = lines(
    [
      '| Option | Type | Default | Notes |',
      '|---|---|---|---|',
      '| `alpha` | `bool` | `true` | |',
      '| `beta` | `int` | `7` | 1–9 pt |',
    ].join('\n'),
  );

  test('a table is recognised by its header, not by its position', () => {
    expect(parseOptionTables(table).map((row) => row.key)).toEqual(['alpha', 'beta']);
  });

  test('the "Option in the plan" trap is not an option table', () => {
    const trap = lines(
      ['| Option in the plan | State | Why |', '|---|---|---|', '| `ghost` | not shipped | |'].join('\n'),
    );
    expect(parseOptionTables(trap)).toEqual([]);
  });

  test('a struck-through row is a removal notice, not a claim', () => {
    const tombstone = lines(
      ['| Option | Type | Default | Notes |', '|---|---|---|---|', '| ~~`gone`~~ | — | — | not in the contract |'].join(
        '\n',
      ),
    );
    expect(parseOptionTables(tombstone)).toEqual([]);
  });

  test('a row reserved to one tool of a shared table is that tool’s claim', () => {
    const shared = lines(
      [
        '| Option | Type | Default | Notes |',
        '|---|---|---|---|',
        '| `pages` | `string[]` | — | the selection |',
        '| `mode` | `include \\| exclude` | `include` | `first-tool` only |',
      ].join('\n'),
    );

    const rows = parseOptionTables(shared, 0, ['first-tool', 'second-tool']);
    expect(rows.find((row) => row.key === 'mode')?.owner).toBe('first-tool');
    expect(rows.find((row) => row.key === 'pages')?.owner).toBeUndefined();
  });

  test('a marker that names no tool of the document leaves the row shared', () => {
    const shared = lines(
      [
        '| Option | Type | Default | Notes |',
        '|---|---|---|---|',
        '| `mode` | `bool` | `true` | `elsewhere` only |',
      ].join('\n'),
    );
    expect(parseOptionTables(shared, 0, ['first-tool'])[0]?.owner).toBeUndefined();
  });

  test('line numbers are absolute, so a finding can be opened', () => {
    const document = lines(['# 0 — Test', '', ...table].join('\n'));
    expect(parseOptionTables(document.slice(2), 2)[0]?.line).toBe(5);
  });
});

describe('options blocks', () => {
  test('a block labelled "as shipped" is the claim, and the sketch above it is not', () => {
    const block = lines(
      [
        '### `tool`',
        '',
        '```ts',
        'options: {',
        '  sketchOnly?: string;',
        '}',
        '```',
        '',
        '**As shipped**, which is what a caller actually sends:',
        '',
        '```ts',
        'options: {',
        '  real: string;',
        '  nested: Array<{',
        '    inner: number;',
        '  }>;',
        '}',
        '```',
      ].join('\n'),
    );

    expect(parseOptionCodeBlocks(block).map((row) => row.key)).toEqual(['real', 'nested']);
  });

  test('with no labelled block, the blocks themselves are the surface', () => {
    const block = lines(['```ts', 'options: {', '  alpha: boolean;', '}', '```'].join('\n'));
    expect(parseOptionCodeBlocks(block).map((row) => row.key)).toEqual(['alpha']);
  });
});

describe('what a row claims', () => {
  test('`string[]` is an array, not a string', () => {
    const option: DocOption = { key: 'pages', source: 'table', line: 1, typeCell: '`PageRange[]`' };
    expect(claimsFrom(option, field('pages')).kinds).toEqual(['array']);
  });

  test('an alternative list is an enum claim, and its members are not type words', () => {
    const option: DocOption = { key: 'kind', source: 'table', line: 1, typeCell: '`text \\| image`' };
    const claims = claimsFrom(option, field('kind'));
    expect(claims.values).toEqual(['text', 'image']);
    expect(claims.kinds).toBeUndefined();
  });

  test('a bound is read from the type cell, from the start of the notes, or from a bolded range', () => {
    const inType: DocOption = { key: 'fontSize', source: 'table', line: 1, typeCell: '`int`, 200–600, optional' };
    const inNotes: DocOption = { key: 'fontSize', source: 'table', line: 1, typeCell: '`int`', notesCell: '6–200 pt' };
    const bolded: DocOption = {
      key: 'scalePercent',
      source: 'table',
      line: 1,
      notesCell: 'gaps as a share, **10–90**; per axis',
    };
    const prose: DocOption = {
      key: 'scalePercent',
      source: 'table',
      line: 1,
      notesCell: 'gaps as a share of the page, see §4',
    };

    expect(claimsFrom(inType, field('fontSize'))).toMatchObject({ min: 200, max: 600 });
    expect(claimsFrom(inNotes, field('fontSize'))).toMatchObject({ min: 6, max: 200 });
    expect(claimsFrom(bolded, field('scalePercent'))).toMatchObject({ min: 10, max: 90 });
    expect(claimsFrom(prose, field('scalePercent')).min).toBeUndefined();
  });

  test('a description in the Default column is not a default', () => {
    const phrase: DocOption = { key: 'kind', source: 'table', line: 1, defaultCell: 'one of the two' };
    const value: DocOption = { key: 'kind', source: 'table', line: 1, defaultCell: '`text`' };

    expect(claimsFrom(phrase, field('kind')).hasDefault).toBe(false);
    expect(claimsFrom(value, field('kind'))).toMatchObject({ hasDefault: true, default: 'text' });
  });

  test('a bare word is a default only when the schema closes the set or declares that same word', () => {
    const enumMember: DocOption = { key: 'kind', source: 'table', line: 1, defaultCell: 'image' };
    const prose: DocOption = { key: 'kind', source: 'table', line: 1, defaultCell: 'auto-generated' };

    expect(claimsFrom(enumMember, field('kind')).default).toBe('image');
    expect(claimsFrom(prose, field('kind')).hasDefault).toBe(false);
  });

  test('a length bound is read when the document says "characters"', () => {
    const option: DocOption = {
      key: 'text',
      source: 'table',
      line: 1,
      notesCell: '1–200 characters; supports `{page}`',
    };
    expect(claimsFrom(option, field('text'))).toMatchObject({ minLength: 1, maxLength: 200 });
  });

  test('a boolean default is read as the value it is', () => {
    const option: DocOption = { key: 'underContent', source: 'table', line: 1, defaultCell: '`false`' };
    expect(claimsFrom(option, field('underContent'))).toMatchObject({ hasDefault: true, default: false });
  });
});

describe('comparing one tool', () => {
  test('the rows a document writes when it agrees report nothing', () => {
    expect(compareTool(watermark, 'doc.md', agreed)).toEqual([]);
  });

  test('an option the schema does not have is a finding, and the only one', () => {
    const findings = compareTool(watermark, 'doc.md', [
      ...agreed,
      { key: 'ghost', source: 'table', line: 9, typeCell: '`bool`' },
    ]);
    expect(kindsOf(findings)).toEqual(['doc-option-not-in-schema:ghost']);
    expect(findings[0]?.line).toBe(9);
  });

  test('a schema option the document never names is a finding, and only that one', () => {
    const findings = compareTool(
      watermark,
      'doc.md',
      agreed.filter((row) => row.key !== 'opacity'),
    );
    expect(kindsOf(findings)).toEqual(['schema-option-not-documented:opacity']);
  });

  test('a kind, an enum, a range, a length and a default each fail on their own', () => {
    expect(kindsOf(compareTool(watermark, 'doc.md', replace('kind', { typeCell: 'string' })))).toEqual([
      'kind-mismatch:kind',
    ]);
    expect(kindsOf(compareTool(watermark, 'doc.md', replace('kind', { typeCell: '`text \\| stamp`' })))).toEqual([
      'enum-mismatch:kind',
    ]);
    expect(kindsOf(compareTool(watermark, 'doc.md', replace('fontSize', { notesCell: '6–300 pt' })))).toEqual([
      'range-mismatch:fontSize',
    ]);
    expect(
      kindsOf(compareTool(watermark, 'doc.md', replace('text', { notesCell: '1–300 characters, and then some' }))),
    ).toEqual(['length-mismatch:text']);
    expect(kindsOf(compareTool(watermark, 'doc.md', replace('kind', { defaultCell: '`image`' })))).toEqual([
      'default-mismatch:kind',
    ]);
  });

  test('a document that bounds what the schema leaves open is a finding, not silence', () => {
    const findings = compareTool(watermark, 'doc.md', replace('scalePercent', { notesCell: '10–90' }));
    expect(kindsOf(findings)).toEqual(['range-mismatch:scalePercent']);
  });

  test('a code block is compared for keys only, because it carries no bounds', () => {
    const findings = compareTool(
      watermark,
      'doc.md',
      agreed.map((row) => ({ ...row, source: 'code-block' as const, typeCell: 'string', defaultCell: '`nonsense`' })),
    );
    expect(findings).toEqual([]);
  });

  test('a row reserved to a sibling tool is not this tool’s claim', () => {
    const findings = compareTool(
      watermark,
      'doc.md',
      agreed.map((row) => ({ ...row, owner: row.key === 'opacity' ? 'other-tool' : undefined })),
    );
    expect(kindsOf(findings)).toEqual(['schema-option-not-documented:opacity']);
  });
});

describe('limits tables', () => {
  const ids = ['split', 'extract-pages', 'delete-pages', 'encrypt', 'restrict', 'unlock', 'linearize'];

  test('a per-tool column table gives each tool its own number', () => {
    const table = lines(
      ['| Limit | `split` | `extract-pages` / `delete-pages` |', '|---|---|---|', '| Timeout | 180 s | 120 s |'].join(
        '\n',
      ),
    );

    expect(parseLimitClaims(table, 'split', 0, ids)[0]).toMatchObject({ seconds: 180, line: 3 });
    expect(parseLimitClaims(table, 'delete-pages', 0, ids)[0]?.seconds).toBe(120);
  });

  test('a cell naming its tools is read per tool, on any of the three separators', () => {
    const commas = lines(
      [
        '| Limit | Value |',
        '|---|---|',
        '| Timeout | 120 s (encrypt/restrict), 90 s (unlock) |',
        '| Memory | 512 MB |',
      ].join('\n'),
    );
    const dots = lines(
      ['| Limit | Value (catalog) |', '|---|---|', '| Timeout | `encrypt` 120 s · `unlock` 90 s |'].join('\n'),
    );

    expect(parseLimitClaims(commas, 'encrypt', 0, ids)[0]?.seconds).toBe(120);
    expect(parseLimitClaims(commas, 'unlock', 0, ids)[0]?.seconds).toBe(90);
    expect(parseLimitClaims(commas, 'linearize', 0, ids)[0]?.megabytes).toBe(512);
    expect(parseLimitClaims(dots, 'unlock', 0, ids)[0]?.seconds).toBe(90);
  });

  test('a number that belongs to another tool is not read', () => {
    const table = lines(['| Limit | Value |', '|---|---|', '| Timeout | `encrypt` 120 s |'].join('\n'));
    expect(parseLimitClaims(table, 'linearize', 0, ids)).toEqual([]);
  });
});

describe('scoping one tool out of a document that publishes several', () => {
  const document = lines(
    [
      '# 0 — Test',
      '## 1. Overview',
      'prose',
      '## 2. Options',
      '### `one`',
      '| Option | Type |',
      '|---|---|',
      '| `alpha` | `bool` |',
      '### `two`',
      '| Option | Type |',
      '|---|---|',
      '| `beta` | `bool` |',
      '## 3. API',
      '| Option | Type |',
      '|---|---|',
      '| `gamma` | `bool` |',
    ].join('\n'),
  );

  test('a scope ends at the next heading of its own level, and keeps absolute lines', () => {
    const scope = scopeForTool(document, 'two', true);
    expect(scope.offset).toBe(8);
    expect(parseOptionTables(scope.lines, scope.offset)).toMatchObject([
      { key: 'beta', source: 'table', line: 12, typeCell: '`bool`' },
    ]);
  });

  test('a tool named by no heading falls back to the whole document', () => {
    expect(scopeForTool(document, 'three', true)).toEqual({ lines: document, offset: 0 });
  });

  test('a single-tool document is its own scope', () => {
    expect(scopeForTool(document, 'one', false)).toEqual({ lines: document, offset: 0 });
  });
});

describe('reading a schema option', () => {
  test('optionality and defaults come from parsing undefined, not from a private field', () => {
    expect(describeSchema('fontSize', optionSchema(watermark).fontSize)).toMatchObject({
      kind: 'number',
      min: 6,
      max: 200,
      hasDefault: true,
      default: 48,
    });
    expect(describeSchema('imageFileId', optionSchema(watermark).imageFileId)).toMatchObject({
      kind: 'string',
      optional: true,
      hasDefault: false,
    });
    expect(describeSchema('kind', optionSchema(watermark).kind)).toMatchObject({
      kind: 'enum',
      values: ['text', 'image'],
      default: 'text',
    });
    expect(describeSchema('pages', optionSchema(watermark).pages)).toMatchObject({ kind: 'array', optional: true });
  });
});
