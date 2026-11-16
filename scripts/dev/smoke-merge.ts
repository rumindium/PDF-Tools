// Smoke test: merge two PDFs end-to-end against a running stack.
// Usage: bun run scripts/dev/smoke-merge.ts   (defaults to http://localhost:8080)

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8080';

// Minimal valid single-page PDF, repeated so the merge has something to compose.
function onePagePdf(label: string): Uint8Array<ArrayBuffer> {
  const content = `BT /F1 24 Tf 72 720 Td (${label}) Tj ET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  // `Uint8Array.from` rather than `Buffer`: a `Buffer` is typed `Uint8Array<ArrayBufferLike>` and so is not a
  // `BlobPart`, which is what the upload below needs. The bytes are identical; only the backing type is narrower.
  return Uint8Array.from(body, (char) => char.charCodeAt(0) & 0xff);
}

async function main() {
  // Anonymous sessions are cookie-based; everything after the first call must present
  // the same `pdft_session` cookie or the uploads "belong to another session".
  let cookie = '';
  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    const session = setCookie?.split(';')[0];
    if (session) cookie = session;
    return res;
  }

  // 1. Upload two PDFs — the endpoint takes exactly one file per call (multipart `files` field).
  const ids: string[] = [];
  for (const [name, label] of [
    ['smoke-a.pdf', 'Smoke A page one'],
    ['smoke-b.pdf', 'Smoke B page one'],
  ] as const) {
    const form = new FormData();
    form.append('files', new Blob([onePagePdf(label)], { type: 'application/pdf' }), name);
    const upRes = await api('/api/v1/files', { method: 'POST', body: form });
    if (!upRes.ok) throw new Error(`upload failed: ${upRes.status} ${await upRes.text()}`);
    const stored = (await upRes.json()) as { id: string };
    ids.push(stored.id);
  }
  console.log(`uploaded: ${ids.length} file(s)`);

  // 2. Create the merge job.
  const jobRes = await api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'merge', files: ids }),
  });
  if (!jobRes.ok) throw new Error(`job create failed: ${jobRes.status} ${await jobRes.text()}`);
  const job = (await jobRes.json()) as { id: string };
  console.log(`job: ${job.id}`);

  // 3. Poll until it leaves the running states.
  let status = 'QUEUED';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await api(`/api/v1/jobs/${job.id}`);
    if (!poll.ok) throw new Error(`poll failed: ${poll.status}`);
    const view = (await poll.json()) as { status: string; progress?: number };
    status = view.status;
    console.log(`  ${status} ${view.progress ?? ''}`);
    if (status === 'COMPLETED' || status === 'FAILED') break;
  }
  if (status !== 'COMPLETED') throw new Error(`job ended as ${status}`);

  // 4. Download the result and assert it is a two-page PDF.
  const dl = await api(`/api/v1/jobs/${job.id}/download`);
  if (!dl.ok) throw new Error(`download failed: ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const pageMatches = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
  console.log(`downloaded ${bytes.length} bytes, /Type /Page objects found: ${pageMatches}`);
  if (bytes.length === 0) throw new Error('empty download');
  if (pageMatches < 2) throw new Error(`expected >= 2 pages in merged output, saw ${pageMatches}`);
  console.log('SMOKE OK: merge produced a 2-page PDF');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
