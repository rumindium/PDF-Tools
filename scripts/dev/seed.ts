import { PLANS, PLAN_ROW_IDS } from '@pdftools/contracts/plans';
import { getDb, schema } from '@pdftools/db';
import { closeDb } from '@pdftools/db';

/**
 * Seeds the `plans` table from `@pdftools/contracts/plans` (`docs/16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3).
 *
 * The constant table is the floor: `planFor()` falls back to it when a row is missing, so a database problem can
 * only ever *narrow* what a caller gets. Seeding copies the same numbers into the database so an operator can
 * raise a limit without a deploy — and this script is how the seed and the code stay equal.
 *
 * Idempotent: re-running updates the row rather than duplicating it.
 *
 *   bun run db:seed
 */
async function main() {
  const db = getDb();
  // `PLAN_ROW_IDS`, not `Object.values(PLANS)`: `guest` is not a plan an operator may tune, and the database's
  // `plan_id` enum deliberately does not carry it (`docs/0-TENANT-FIRST.md` §4.1). Naming the list in `plans.ts`
  // rather than filtering here keeps the seeder and the enum talking about the same set.
  // The id is spread back over the row rather than trusted from `PLANS[id]`, whose declared type is the wide
  // `PlanId` — the value would be right and the database insert would still be untyped against a four-member enum.
  const rows = PLAN_ROW_IDS.map((id) => ({ ...PLANS[id], id }));

  for (const plan of rows) {
    await db
      .insert(schema.plans)
      .values({
        id: plan.id,
        name: plan.name,
        maxFileMb: plan.maxFileMb,
        maxJobMb: plan.maxJobMb,
        maxPages: plan.maxPages,
        maxFiles: plan.maxFiles,
        jobsPerWindow: plan.jobsPerWindow,
        windowSeconds: plan.windowSeconds,
        maxConcurrent: plan.maxConcurrent,
        queuePriority: plan.queuePriority,
        resultTtlMinutes: plan.resultTtlMinutes,
        historyDays: plan.historyDays,
        maxApiKeys: plan.maxApiKeys,
        tools: plan.tools,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.plans.id,
        set: {
          name: plan.name,
          maxFileMb: plan.maxFileMb,
          maxJobMb: plan.maxJobMb,
          maxPages: plan.maxPages,
          maxFiles: plan.maxFiles,
          jobsPerWindow: plan.jobsPerWindow,
          windowSeconds: plan.windowSeconds,
          maxConcurrent: plan.maxConcurrent,
          queuePriority: plan.queuePriority,
          resultTtlMinutes: plan.resultTtlMinutes,
          historyDays: plan.historyDays,
          maxApiKeys: plan.maxApiKeys,
          tools: plan.tools,
          updatedAt: new Date(),
        },
      });
    console.log(
      `plan ${plan.id.padEnd(10)} ${plan.maxPages} pages · ${plan.maxJobMb} MB/job · ${plan.jobsPerWindow} jobs/${plan.windowSeconds / 3600}h`,
    );
  }

  console.log(`\nseeded ${rows.length} plans`);
  await closeDb();
}

await main();
