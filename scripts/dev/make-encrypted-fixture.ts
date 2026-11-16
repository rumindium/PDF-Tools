import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Build the encrypted fixture `unlock` needs: an AES-256 document with a **known** user password and a known owner
 * password.
 *
 * Both passwords are constants in this file, and that is the point rather than a shortcut: a fixture whose password
 * nobody can read is a fixture no case can use, and generating a random one per run would make the suite's assertions
 * depend on a value that is not in the repository. They are also deliberately different from each other — qpdf treats
 * an absent owner password as insecure, and a fixture that shared them would not exercise the "owner password also
 * opens the file" path that `unlock` relies on.
 *
 * The fixture is built **inside the light worker** because qpdf lives there and not on the host, which is the same
 * reason `make-scan-fixture.ts` rasterises with Ghostscript in a container. Unlike that script, this one also asks the
 * container to *verify* what it wrote — the file must report `R = 6` / `AESv3`, must open with the user password, and
 * must NOT open without it. A fixture that quietly failed to encrypt would make every `unlock` case pass for the wrong
 * reason, and the failure would show up as "the tool did nothing" rather than as "the fixture was never protected".
 *
 *   docker compose up -d worker-light
 *   bun run fixtures:encrypted
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const SOURCE = join(OUT_DIR, 'pages-six-a4.pdf');
const TARGET = join(OUT_DIR, 'protected-aes256-a4.pdf');
const CONTAINER = 'worker-light';

/** Known to the golden cases; see `10-PROTECT-AND-UNLOCK.md` §7. */
export const FIXTURE_USER_PASSWORD = 'fixture-user-pass';
export const FIXTURE_OWNER_PASSWORD = 'fixture-owner-pass';

/**
 * Which compose file the container belongs to (`make-image-fixtures.ts` explains why: CI starts the light pool from
 * `docker-compose.ci.yml`, so a hard-coded `docker compose exec` finds no such service there).
 */
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const compose = COMPOSE_FILE ? ['-f', COMPOSE_FILE] : [];
  const proc = Bun.spawn(['docker', 'compose', ...compose, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  if (!(await stat(SOURCE).catch(() => null))) {
    console.error(`missing ${SOURCE} — run \`bun run fixtures\` first`);
    process.exit(1);
  }

  const ps = await docker(['ps', '--status', 'running', '--services']);
  if (!ps.stdout.split('\n').includes(CONTAINER)) {
    console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
    process.exit(1);
  }

  // Both passwords travel on qpdf's command line here, which is acceptable **because they are fixtures published in
  // this file** — the opposite of the handler's rule, where a caller's password must never reach argv.
  const inner = [
    'set -e',
    `qpdf --encrypt '${FIXTURE_USER_PASSWORD}' '${FIXTURE_OWNER_PASSWORD}' 256 ${[
      '--print=low --extract=n --modify=none --annotate=n --form=n --assemble=n --accessibility=y --',
      '/tmp/encrypted-fixture/source.pdf /tmp/encrypted-fixture/protected.pdf',
    ].join(' ')}`,
    'echo "=== report ==="',
    'qpdf --show-encryption /tmp/encrypted-fixture/protected.pdf',
    'echo "=== opens-with-user-password ==="',
    `qpdf --password='${FIXTURE_USER_PASSWORD}' --show-npages /tmp/encrypted-fixture/protected.pdf`,
    'echo "=== opens-without-password (must fail) ==="',
    'qpdf --show-npages /tmp/encrypted-fixture/protected.pdf || echo "refused, as intended"',
  ].join('; ');

  // The scratch directory is cleaned and created **before** the copy, not inside the command that runs after it:
  // `rm -rf` there would delete the source file that was just copied in.
  const prepared = await docker([
    'exec',
    '-T',
    CONTAINER,
    'sh',
    '-c',
    'rm -rf /tmp/encrypted-fixture && mkdir -p /tmp/encrypted-fixture',
  ]);
  if (prepared.code !== 0) {
    console.error(`could not prepare the scratch directory in ${CONTAINER}: ${prepared.stderr.trim()}`);
    process.exit(1);
  }

  const copyIn = await docker(['cp', SOURCE, `${CONTAINER}:/tmp/encrypted-fixture/source.pdf`]);
  if (copyIn.code !== 0) {
    console.error(`could not copy the source fixture into ${CONTAINER}: ${copyIn.stderr.trim()}`);
    process.exit(1);
  }

  const built = await docker(['exec', '-T', CONTAINER, 'sh', '-c', inner]);
  if (built.code !== 0) {
    console.error(`qpdf failed in ${CONTAINER}:\n${built.stderr.trim()}`);
    process.exit(1);
  }

  const report = built.stdout;
  const problems: string[] = [];
  if (!/^R = 6$/m.test(report)) problems.push('the file does not report revision 6');
  if (!/stream encryption method: AESv3/.test(report)) problems.push('the file is not AES-256');
  if (!/extract for any purpose: not allowed/.test(report)) problems.push('the copy permission is not denied');
  if (!/=== opens-with-user-password ===\n6\b/.test(report)) {
    problems.push('the user password does not open the fixture');
  }
  if (!/refused, as intended/.test(report)) problems.push('the file opens without a password');
  if (problems.length > 0) {
    console.error(`the fixture is not what the cases need:\n  - ${problems.join('\n  - ')}\n\n${report}`);
    process.exit(1);
  }

  const copiedOut = await docker(['cp', `${CONTAINER}:/tmp/encrypted-fixture/protected.pdf`, TARGET]);
  if (copiedOut.code !== 0) {
    console.error(`could not copy the fixture out of ${CONTAINER}: ${copiedOut.stderr.trim()}`);
    process.exit(1);
  }
  await docker(['exec', '-T', CONTAINER, 'rm', '-rf', '/tmp/encrypted-fixture']);

  const size = (await stat(TARGET)).size;
  console.log(`wrote ${TARGET}`);
  console.log(`  verified: R = 6, AESv3, copy denied, ${size} bytes, opens only with the user password`);
  console.log(`  user password  ${FIXTURE_USER_PASSWORD}`);
  console.log(`  owner password ${FIXTURE_OWNER_PASSWORD}`);
}

await main();
