/**
 * Print a `pdf-to-pdfa` job's own account of what it did — the `changes` array, `metrics.outputIntent`,
 * `conformance` and the warnings. The golden suite asserts the *file*; this asks the job what it thinks it produced,
 * which is the pair that has to agree.
 *
 * Usage: bun run scripts/ci/pdfa-metrics.ts [profile]
 */

import { requireAnonymousUse } from '../../e2e/lib/stack-gap';

const base = process.env.BASE ?? 'http://localhost:8080';
const profile = process.argv[2] ?? '2b';
const token = process.env.DEV_PLAN_TOKEN ?? 'dev-plan-token';

// This tool is a window onto a job the stack has to run first, so it needs a stack that lets a caller with no account
// start one (`e2e/lib/stack-gap.ts`). Checked before anything is uploaded, so the answer is a line rather than a
// crash halfway through a fixture.
await requireAnonymousUse(base, 'this tool uploads a fixture and submits an archival job');

let cookie = '';
const call = async (path: string, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  if (cookie) headers.set('cookie', cookie);
  headers.set('x-dev-plan', 'pro');
  headers.set('x-dev-plan-token', token);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    if (pair?.startsWith('pdft_session=')) cookie = pair;
  }
  return response;
};

await call('/api/v1/session', { method: 'POST' });

const form = new FormData();
form.append('kind', 'input');
form.append(
  'file',
  new Blob([await Bun.file('fixtures/generated/pages-six-a4.pdf').arrayBuffer()], { type: 'application/pdf' }),
  'pages-six-a4.pdf',
);
const uploaded = await call('/api/v1/files', { method: 'POST', body: form });
const fileId = ((await uploaded.json()) as { id: string }).id;

const created = await call('/api/v1/jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'pdf-to-pdfa', files: [fileId], options: { profile } }),
});
if (created.status !== 202) {
  console.error(`job refused: ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { id } = (await created.json()) as { id: string };

for (let attempt = 0; attempt < 120; attempt += 1) {
  const view = (await (await call(`/api/v1/jobs/${id}`)).json()) as {
    status: string;
    error: { code: string; message: string } | null;
    warnings: Array<{ code: string; detail?: string }>;
    metrics?: Record<string, unknown>;
  };
  if (view.status === 'COMPLETED' || view.status === 'FAILED') {
    console.log(`job ${id} → ${view.status} (profile ${profile})\n`);
    if (view.error) console.log(`error: ${view.error.code} — ${view.error.message}\n`);
    // The metrics travel on `/result`, not on the job view.
    const result = (await (await call(`/api/v1/jobs/${id}/result`)).json()) as {
      metrics?: Record<string, unknown>;
      warnings: Array<{ code: string; detail?: string }>;
    };
    console.log('metrics:', JSON.stringify(result.metrics, null, 2));
    console.log('\nwarnings:', JSON.stringify(result.warnings, null, 2));
    process.exit(view.status === 'COMPLETED' ? 0 : 1);
  }
  await Bun.sleep(500);
}
console.error('timed out');
process.exit(1);
