import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@pdftools/config';
import { memoryLimitSupport, run } from '@pdftools/engines';

/**
 * Prints the engine versions available in this environment (`docs/0-CICD.md` §11).
 *
 * Support's first question about a conversion that looks wrong is "which version produced it". The answer should
 * not require shell access to a production host, so this runs in CI (recording the versions per image) and on
 * demand during an incident.
 *
 * A missing binary is reported as `unavailable` rather than throwing: inside the API image *every* engine is
 * expected to be missing, and that is correct, not an error.
 *
 *   bun run engines:check
 */
interface EngineProbe {
  name: string;
  binary: string;
  args: string[];
  pool: string;
}

const PROBES: EngineProbe[] = [
  { name: 'qpdf', binary: config.engines.qpdf ?? 'qpdf', args: ['--version'], pool: 'light, heavy' },
  { name: 'mutool', binary: config.engines.mutool ?? 'mutool', args: ['-v'], pool: 'light, heavy' },
  { name: 'ghostscript', binary: config.engines.ghostscript ?? 'gs', args: ['--version'], pool: 'light, heavy, ocr' },
  { name: 'imagemagick', binary: config.engines.magick ?? 'magick', args: ['-version'], pool: 'light, heavy' },
  { name: 'poppler-pdfinfo', binary: 'pdfinfo', args: ['-v'], pool: 'light, heavy, ocr' },
  { name: 'libreoffice', binary: config.engines.soffice ?? 'soffice', args: ['--version'], pool: 'office' },
  { name: 'tesseract', binary: config.engines.tesseract ?? 'tesseract', args: ['--version'], pool: 'ocr' },
  { name: 'ocrmypdf', binary: config.engines.ocrmypdf ?? 'ocrmypdf', args: ['--version'], pool: 'ocr' },
  { name: 'python3', binary: config.engines.python, args: ['--version'], pool: 'all' },
  { name: 'veraPDF', binary: config.engines.verapdf ?? 'verapdf', args: ['--version'], pool: 'heavy (optional)' },
];

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), 'pdftools-engines-'));
  const rows: string[] = [];
  let missing = 0;

  for (const probe of PROBES) {
    const resolved = config.engines[engineKey(probe.name)] ?? null;
    const binary = resolved ?? probe.binary;
    try {
      const result = await run(binary, probe.args, { cwd, timeoutMs: 15_000, engine: probe.name });
      const version = firstLine(result.stdout || result.stderr);
      rows.push(`${probe.name.padEnd(18)} ${version.padEnd(40)} ${probe.pool}`);
    } catch {
      missing += 1;
      rows.push(`${probe.name.padEnd(18)} ${'unavailable'.padEnd(40)} ${probe.pool}`);
    }
  }

  console.log('engine              version                                  expected pool\n');
  console.log(rows.join('\n'));
  console.log(`\n${PROBES.length - missing} of ${PROBES.length} available · ${cwd}`);

  // What a tool's `limits.memoryMb` does *here*, printed where an operator already looks for "which engine produced
  // this". On Linux the spawn path applies it as an `RLIMIT_AS` ceiling on every engine; anywhere else — a
  // developer's machine, macOS — the field is declared and not applied, and that is a fact about the environment
  // rather than something to infer from a job that exhausted the host (`docs/0-IMPLEMENTATION-STATUS.md` §6).
  const memory = memoryLimitSupport();
  console.log(`memory budget  ${memory.reason}`);
}

function engineKey(name: string): keyof typeof config.engines {
  switch (name) {
    case 'qpdf':
      return 'qpdf';
    case 'mutool':
      return 'mutool';
    case 'ghostscript':
      return 'ghostscript';
    case 'imagemagick':
      return 'magick';
    case 'libreoffice':
      return 'soffice';
    case 'tesseract':
      return 'tesseract';
    case 'ocrmypdf':
      return 'ocrmypdf';
    case 'veraPDF':
      return 'verapdf';
    default:
      return 'python';
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 38);
}

await main();
