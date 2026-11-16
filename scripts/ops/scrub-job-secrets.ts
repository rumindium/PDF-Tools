import { SECRET_PLACEHOLDER, TOOLS, getTool, secretKeysFor, secretViolations } from '@pdftools/contracts';
import { closeDb, rawSql } from '@pdftools/db';

/**
 * Find — and optionally remove — declared secrets sitting in the clear in `jobs.options`
 * (`docs/0-SECURITY.md` §5).
 *
 * The API stopped writing passwords down when the secret mechanism shipped, but rows written by the build before it
 * did still hold them: an `encrypt` job from last week has its password in a JSONB column, and rewriting the code
 * does not rewrite the past. Those rows are the reason this script exists, and the reason the E2E audit queries the
 * whole table rather than only the job that just ran.
 *
 * Only the tools whose catalog entry declares a secret are examined, and only at the declared keys — the script has
 * no list of its own. That is what makes it safe to run against a database whose history it does not know: it cannot
 * mistake a filename for a password, and adding a tool with a secret needs no edit here.
 *
 *   bun run secrets:audit                      report only
 *   bun run secrets:audit -- --scrub           replace the values with the placeholder
 *   bun run secrets:audit -- --scrub --tool encrypt
 *
 * Scrubbing is irreversible and it costs nothing: a finished job's password is only good for opening the result it
 * already produced, and the caller is the one who chose that password. Losing the copy in the row costs nothing;
 * keeping it costs a credential in every backup ever taken of this database.
 */
async function main() {
  const argv = process.argv.slice(2);
  const scrub = argv.includes('--scrub');
  const only = argv.includes('--tool') ? argv[argv.indexOf('--tool') + 1] : undefined;

  const declared = TOOLS.filter((tool) => secretKeysFor(tool).length > 0).map((tool) => tool.id);
  const targets = only ? declared.filter((id) => id === only) : declared;
  if (targets.length === 0) {
    console.error(`No tool declares a secret${only ? ` (asked for "${only}")` : ''}. Declared: ${declared.join(', ')}`);
    process.exit(2);
  }

  // Raw SQL rather than the query builder: this is an audit over every row of a table, which is exactly the shape
  // `docs/0-DATABASE.md` reserves the raw client for.
  const sql = rawSql();
  const rows = await sql<Array<{ id: string; tool: string; status: string; options: Record<string, unknown> }>>`
    select id, tool, status, options from jobs where tool in ${sql(targets)}
  `;

  const offenders = rows
    .map((row) => ({ row, keys: secretViolations(getTool(row.tool) ?? {}, row.options ?? {}) }))
    .filter((entry) => entry.keys.length > 0);

  console.log(`tools with a declared secret: ${targets.join(', ')}`);
  console.log(`rows examined: ${rows.length} · rows holding a secret in the clear: ${offenders.length}\n`);

  if (offenders.length === 0) {
    console.log('Nothing to do: no row holds a declared secret outside the placeholder.');
    return;
  }

  for (const { row, keys } of offenders) {
    console.log(`  ${row.id}  ${row.tool.padEnd(9)} ${row.status.padEnd(10)} ${keys.join(', ')}`);
  }

  if (!scrub) {
    console.log(`\nRe-run with --scrub to replace ${offenders.length} value(s) with ${SECRET_PLACEHOLDER}.`);
    return;
  }

  for (const { row, keys } of offenders) {
    const options: Record<string, unknown> = { ...(row.options ?? {}) };
    for (const key of keys) options[key] = SECRET_PLACEHOLDER;
    // One statement per row, and only the rows that need it: a scrub that rewrote every row of the table would be
    // a bigger change to a production database than the problem it is fixing.
    await sql`update jobs set options = ${JSON.stringify(options)}::jsonb where id = ${row.id}`;
  }
  console.log(`\nScrubbed ${offenders.length} row(s).`);
}

await main().finally(async () => {
  await closeDb();
});
