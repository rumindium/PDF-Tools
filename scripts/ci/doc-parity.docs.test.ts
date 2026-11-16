import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TOOLS } from '@pdftools/contracts';
import { checkDocuments } from './doc-parity';

/**
 * The document comparison, run against the documents themselves — and against four deliberate breakages.
 *
 * `doc-parity.test.ts` proves the parser's rules; this file proves the thing the stage exists for: that the
 * fifteen documents agree with the schemas, the catalog and the map, and that **the stage fails when they stop
 * agreeing**. Both halves matter. A green run over the real documents is only evidence of the first; the four
 * mutations below are evidence of the second, because a check that cannot be seen to fail is a check nobody
 * knows the shape of — the failure mode of this whole document is a stage that reports "33 tools agree" from an
 * option reader that matched nothing.
 *
 * Each mutation **throws if it changed nothing**. A document rewrite that moves the row a test rewrites would
 * otherwise turn that test into a vacuous pass, which is the same defect this suite was written to catch.
 *
 * The documents live in the sibling `Auth-Platform` repository, so the suite skips — loudly, naming the path —
 * in a `pdf-tools`-only checkout, exactly as the stage reports a gap there (exit 3). Set `PDFTOOLS_DOCS` to
 * point it somewhere else.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const DOCS = process.env.PDFTOOLS_DOCS ?? resolve(ROOT, '../Auth-Platform/docs/13-integration/PDF-TOOLS');
const available = existsSync(join(DOCS, '01-MERGE.md'));

if (!available) {
  // Printed rather than silent: a skipped suite that nobody notices is how a check stops running for a year.
  console.log(`doc parity (documents): skipped — no documents at ${DOCS}`);
}

const withDocs = available ? describe : describe.skip;
const kindsOf = (findings: Array<{ kind: string; key: string }>): string[] =>
  findings.map((finding) => `${finding.kind}:${finding.key}`).sort();

/** A copy of the real documents with one document rewritten by `change`. */
async function brokenCopy(file: string, change: (text: string) => string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doc-parity-'));
  await cp(DOCS, dir, { recursive: true });
  const path = join(dir, file);
  const before = await readFile(path, 'utf8');
  const after = change(before);
  if (after === before) {
    throw new Error(`${file}: the mutation changed nothing — the row it rewrites has moved or been reworded`);
  }
  await writeFile(path, after);
  return dir;
}

const withCopy = async (file: string, change: (text: string) => string, assert: (dir: string) => Promise<void>) => {
  const dir = await brokenCopy(file, change);
  try {
    await assert(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const tool = (id: string) => {
  const found = TOOLS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no tool ${id} in the registry`);
  return found;
};

withDocs('the fifteen documents', () => {
  test('every tool agrees with its document, its schema, the catalog and the map', async () => {
    const { tools, findings, mapErrors } = await checkDocuments(DOCS);

    expect(findings).toEqual([]);
    expect(mapErrors).toEqual([]);
    expect(tools).toHaveLength(TOOLS.length);
    expect(tools.filter((entry) => entry.coverage === 'none')).toEqual([]);
  });

  test('the coverage is stated per tool, so a document that moves to prose shows up', async () => {
    const { tools } = await checkDocuments(DOCS);

    // The numbers the stage prints: 27 tools publish an option table, the six form tools publish an `options:`
    // block (`13-EDIT-AND-ANNOTATE.md` and `14-SIGN-AND-FORMS.md`). Asserted rather than printed, because a
    // document that quietly stopped publishing options would otherwise pass as a smaller green run.
    expect(tools.filter((entry) => entry.coverage === 'table')).toHaveLength(27);
    expect(tools.filter((entry) => entry.coverage === 'code-block')).toHaveLength(6);
    for (const entry of tools) {
      expect([entry.tool, entry.documented]).toEqual([entry.tool, entry.accepted]);
    }
  });
});

withDocs('a document that stops agreeing', () => {
  /** Set by the deletion below, so the assertion can name the row the document lost. */
  const dropped = { key: '' };

  test('an option row the schema does not accept is a failure', async () => {
    await withCopy(
      '01-MERGE.md',
      (text) =>
        text.replace(
          /^(\| Option .*\|)\n(\|[\s:|-]+\|)$/m,
          '$1\n$2\n| `ghostOption` | `bool` | `true` | invented by this test |',
        ),
      async (dir) => {
        const { findings } = await checkDocuments(dir);
        expect(kindsOf(findings)).toEqual(['doc-option-not-in-schema:ghostOption']);
      },
    );
  });

  test('an option the document drops is a failure', async () => {
    await withCopy(
      '01-MERGE.md',
      (text) =>
        text.replace(
          /^(\| Option .*\|)\n(\|[\s:|-]+\|)\n(\| `([a-zA-Z]+)`.*\|)$/m,
          (_whole, header, separator, _row, key) => {
            dropped.key = key;
            return `${header}\n${separator}`;
          },
        ),
      async (dir) => {
        expect(dropped.key).not.toBe('');
        const { findings } = await checkDocuments(dir);
        expect(kindsOf(findings)).toEqual([`schema-option-not-documented:${dropped.key}`]);
      },
    );
  });

  test('a bound that differs from the schema is a failure', async () => {
    await withCopy(
      '11-WATERMARK.md',
      (text) => text.replace(/(`fontSize` \| number \| `48` \| )6–200( pt)/, '$16–300$2'),
      async (dir) => {
        const { findings } = await checkDocuments(dir);
        expect(kindsOf(findings)).toEqual(['range-mismatch:fontSize']);
      },
    );
  });

  test('a timeout that differs from the catalog is a failure', async () => {
    const declared = tool('pdf-to-pdfa').limits.timeoutSeconds;
    const wrong = declared === 999 ? 998 : 999;
    await withCopy(
      '09-PDF-A.md',
      (text) => text.replace(/^(\| Timeout \|)[^|]*\|$/m, `$1 ${wrong} s |`),
      async (dir) => {
        const { findings } = await checkDocuments(dir);
        expect(kindsOf(findings)).toEqual(['limit-mismatch:limits.timeoutSeconds']);
        expect(findings[0]?.detail).toContain(`${wrong} s`);
        expect(findings[0]?.detail).toContain(`${declared} s`);
      },
    );
  });
});

withDocs('a checkout without the documents', () => {
  test('the map reports every document it cannot read instead of comparing nothing', async () => {
    const { findings, mapErrors } = await checkDocuments(join(DOCS, 'does-not-exist'));

    expect(findings).toEqual([]);
    expect(mapErrors.length).toBeGreaterThan(0);
    expect(mapErrors[0]).toContain('is named by the map and not on disk');
  });
});
