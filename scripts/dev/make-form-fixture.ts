import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { planWorkerExec, workerTransport } from './worker-transport';

/**
 * Build the AcroForm fixture `extract-fields` and `fill-form` need.
 *
 * Written by hand as dictionaries rather than with a form builder, and that is the point: every field type a real
 * document carries — text, checkbox, choice, radio group, signature — plus **one deliberate omission**: the text
 * field has no appearance stream, which is the shape of the majority of real forms and the reason `extract-fields`
 * has an `APPEARANCE_MISSING` warning to report. A builder would give every field an appearance and the warning
 * branch would never run against a fixture.
 *
 * Two details that make this file a fixture rather than a guess, both measured in the probes first
 * (`scripts/dev/probe-forms.py`):
 *
 *  - **Keyword dictionary keys go in without the leading slash.** `Dictionary(**{'/Yes': stream})` writes the key
 *    `//Yes`, a name no `/AS /Yes` can ever resolve, so the checkbox renders empty forever while every API reports it
 *    checked. The appearance map is built with `Yes=…, Off=…`.
 *  - **No `/NeedAppearances`.** A form that asks readers to regenerate its appearances makes two readers disagree
 *    about what the page shows, which turns every later assertion into an argument about the reader.
 *
 * The verification is the other half. A fixture whose checkbox state names are wrong would make the `fill-form` cases
 * pass *or* fail for reasons that have nothing to do with the handler, so this script reads its own output back with
 * **PyMuPDF** (a different engine from the pikepdf that wrote it), asserts the appearance state names, and asserts the
 * pre-filled choice value survives. A fixture that quietly lost a field must fail here, not in a golden case.
 *
 * A **second** file comes out of the same build: `form-xfa-a4.pdf`, the same document with an `/XFA` packet added
 * beside its AcroForm. XFA is the other form model, `14-SIGN-AND-FORMS.md` §4 asks for `FORM_XFA` when a document
 * carries one, and until pass 9 no fixture had one — so that branch had no case and the warning had no raise site. The
 * packet is written **uncompressed** on purpose: the golden case asserts the packet survives the fill by finding its own
 * marker in the output's bytes, and a deflated packet would make that search a search of compressed data.
 *
 *   docker compose up -d worker-heavy
 *   bun run fixtures:form
 *
 * Neither the `docker compose` line nor Docker itself is required: `make-form-fixture` asks
 * `scripts/dev/worker-transport.ts` where to run the builder, which is the `worker-heavy` container when a daemon
 * answers and **this host** otherwise — the `scripts/noroot-stack.sh` case, where the engines are the ones
 * `noroot-stack.sh engines` provisioned. Then:
 *
 *   eval "$(scripts/noroot-stack.sh env)"    # pikepdf and PyMuPDF on PATH
 *   bun run fixtures:form
 */

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(ROOT, 'fixtures', 'generated');
const TARGET = join(OUT_DIR, 'form-five-fields-a4.pdf');
const XFA_TARGET = join(OUT_DIR, 'form-xfa-a4.pdf');
/** Written into the XFA packet, and asserted by a golden case in the *output's* bytes after a fill. */
export const XFA_PACKET_MARKER = 'PDFTOOLS-XFA-DATA';
const CONTAINER = 'worker-heavy';
const COMPOSE_FILE = process.env.PDFTOOLS_COMPOSE_FILE;
/** Where the builder stages both files — inside the container, and on this host when there is no daemon. */
const STAGE = '/tmp/form-fixture';

/**
 * The field geometry, in PDF points, exported so a golden case can assert ink *inside* a box it did not invent.
 *
 * A placement assertion that repeats the numbers is a second copy that can drift from the first; these are the
 * fixture's own coordinates and the cases import them.
 */
export const FORM_FIXTURE_BOXES = {
  text: { x: 72, y: 640, width: 248, height: 24 },
  checkbox: { x: 72, y: 600, width: 14, height: 14 },
  choice: { x: 72, y: 560, width: 168, height: 24 },
  signature: { x: 72, y: 470, width: 168, height: 24 },
  highlight: { x: 72, y: 430, width: 248, height: 14 },
} as const;

/** The value the fixture ships with, so a read case has something to read rather than only empty fields. */
export const FORM_FIXTURE_PREFILLED = { field: 'department', value: 'IT' } as const;

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const compose = COMPOSE_FILE ? ['-f', COMPOSE_FILE] : [];
  const proc = Bun.spawn(['docker', 'compose', ...compose, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Take one staged file out of wherever the builder ran.
 *
 * `docker cp` is the container's half; the local half is a plain file copy, because the builder wrote into this host's
 * `STAGE` in the first place. Same staging path in both, so the two file names the rest of the script refers to do not
 * change with the transport.
 */
async function copyOut(name: string, target: string): Promise<{ code: number; stderr: string }> {
  if (workerTransport() === 'docker') {
    const copied = await docker(['cp', `${CONTAINER}:${STAGE}/${name}`, target]);
    return { code: copied.code, stderr: copied.stderr };
  }
  try {
    await copyFile(join(STAGE, name), target);
    return { code: 0, stderr: '' };
  } catch (error) {
    return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The builder, which runs inside the container — pikepdf and PyMuPDF live there and not on the host, by this repo's
 * design. It prints one JSON report line; this script turns any disagreement into a non-zero exit.
 */
const BUILD_SCRIPT = `import json, os, subprocess, sys
import pikepdf
import pymupdf
from pikepdf import Array, Dictionary, Name, String

OUT = "/tmp/form-fixture/form-five-fields-a4.pdf"
XFA_OUT = "/tmp/form-fixture/form-xfa-a4.pdf"
BOX = ${JSON.stringify(FORM_FIXTURE_BOXES)}

pdf = pikepdf.Pdf.new()
page = pdf.add_blank_page(page_size=(595, 842))
font = pdf.make_indirect(Dictionary(Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/Helvetica")))
page.Resources = Dictionary(Font=Dictionary(Helv=font))


def rect(box):
    return Array([box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]])


def appearance(inner):
    """A 14x14 /Form XObject carrying one drawn state, sized to the checkbox it belongs to."""
    return pdf.make_indirect(
        pikepdf.Stream(pdf, inner, Type=Name("/XObject"), Subtype=Name("/Form"), FormType=1, BBox=Array([0, 0, 14, 14]))
    )


def widget(box, extra):
    annot = Dictionary(
        Type=Name("/Annot"),
        Subtype=Name("/Widget"),
        Rect=rect(box),
        F=4,
        P=page.obj,
        DA=String("/Helv 10 Tf 0 g"),
        **extra,
    )
    return pdf.make_indirect(annot)


# 1. Text: required, capped, and **without** an appearance stream — the state a real form is most often in, and the
#    branch extract-fields warns about.
employee = widget(BOX["text"], dict(FT=Name("/Tx"), T=String("employee_name"), Ff=2, MaxLen=80))

# 2. Checkbox: one appearance per state, with the state names spelled the way /AS resolves them.
ack = widget(
    BOX["checkbox"],
    dict(
        FT=Name("/Btn"),
        T=String("acknowledged"),
        V=Name("/Off"),
        AS=Name("/Off"),
        AP=Dictionary(N=Dictionary(Yes=appearance(b"q 0 0 0.6 rg 2 2 10 10 re f Q"),
                                   Off=appearance(b"q 0.5 0.5 0.5 RG 1 w 1 1 12 12 re S Q"))),
    ),
)

# 3. Choice, pre-filled: a read tool with nothing to read proves nothing.
department = widget(
    BOX["choice"],
    dict(FT=Name("/Ch"), T=String("department"), V=String("IT"),
         Opt=Array([String("Finance"), String("IT"), String("Operations")])),
)

# 4. Radio group: the case that makes the walk's shape matter — two widgets, one field. Built as a parent with /Kids,
#    which is how a reader sees it, so a walk over /Fields that ignores /Kids reports one box and misses the other.
shift_parent = pdf.make_indirect(
    Dictionary(FT=Name("/Btn"), T=String("shift"), Ff=1 << 15, V=Name("/Off"), Kids=Array([]))
)
shift_kids = []
for index, x in enumerate((72, 100)):
    kid = pdf.make_indirect(
        Dictionary(
            Type=Name("/Annot"),
            Subtype=Name("/Widget"),
            FT=Name("/Btn"),
            Parent=shift_parent,
            Rect=Array([x, 520, x + 14, 534]),
            F=4,
            P=page.obj,
            AS=Name("/Off"),
            AP=Dictionary(N=Dictionary(Yes=appearance(b"q 0 0 0.6 rg 7 7 m 2 2 l 12 2 l f Q"),
                                       Off=appearance(b"q 0.5 0.5 0.5 RG 1 w 1 1 12 12 re S Q"))),
        )
    )
    shift_kids.append(kid)
shift_parent["/Kids"] = Array(shift_kids)

# 5. Signature: a field type that cannot be filled, so fill-form's skip path has a subject.
signature = widget(BOX["signature"], dict(FT=Name("/Sig"), T=String("approver_signature")))

page.obj["/Annots"] = Array([employee, ack, department, *shift_kids, signature])

# A highlight that is **not** a widget, in the same file on purpose: it is the page content a flatten must not lose.
# It carries an appearance stream because that is what makes it bake-able at all — measured: qpdf skips any annotation
# without one and leaves it exactly where it was, so a highlight with no /AP would survive every flatten and the check
# "the mark is still drawn after flattening" could never fail. The appearance is deliberately **darker than its /C**:
# the harness measures ink as pixels below 200/255, and a real pale-yellow highlight renders at about 219, which is
# the same limitation recorded for \`annotate\`'s light marks.
highlight = pdf.make_indirect(
    Dictionary(
        Type=Name("/Annot"),
        Subtype=Name("/Highlight"),
        Rect=rect(BOX["highlight"]),
        F=4,
        P=page.obj,
        C=Array([1, 0.9, 0.2]),
        AP=Dictionary(
            N=pdf.make_indirect(
                pikepdf.Stream(
                    pdf,
                    ("q 0.45 0.36 0.08 rg 0 0 %d %d re f Q" % (BOX["highlight"]["width"], BOX["highlight"]["height"])).encode(),
                    Type=Name("/XObject"),
                    Subtype=Name("/Form"),
                    FormType=1,
                    BBox=Array([0, 0, BOX["highlight"]["width"], BOX["highlight"]["height"]]),
                )
            )
        ),
        QuadPoints=Array([
            BOX["highlight"]["x"], BOX["highlight"]["y"] + BOX["highlight"]["height"],
            BOX["highlight"]["x"] + BOX["highlight"]["width"], BOX["highlight"]["y"] + BOX["highlight"]["height"],
            BOX["highlight"]["x"], BOX["highlight"]["y"],
            BOX["highlight"]["x"] + BOX["highlight"]["width"], BOX["highlight"]["y"],
        ]),
    )
)
page.obj["/Annots"].append(highlight)

pdf.Root.AcroForm = pdf.make_indirect(
    Dictionary(Fields=Array([employee, ack, department, shift_parent, signature]))
)
pdf.save(OUT)

# ── The XFA twin: the same form with a second, competing form model beside it ────────────────────────────────────
# \`fill-form\` writes into the AcroForm mirror and leaves the packet alone; the warning exists so the caller knows the
# two models may disagree. Uncompressed, so a golden case can find the marker in the output.
XFA = """<?xml version="1.0" encoding="UTF-8"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
  <subform name="form1">
    <field name="employee_name"><ui><textEdit/></ui><value><text>PDFTOOLS-XFA-DATA</text></value></field>
  </subform>
</template>
"""
with pikepdf.Pdf.open(OUT) as xfa_pdf:
    packet = pikepdf.Stream(xfa_pdf, XFA.encode("utf-8"))
    xfa_pdf.Root.AcroForm["/XFA"] = xfa_pdf.make_indirect(packet)
    # Streams left uncompressed (pikepdf deflates them by default): the marker below is what both this build's own
    # verification and the golden case look for, and a deflated packet would make that search a search of compressed
    # bytes. Nothing here is large enough for the sizes to matter.
    xfa_pdf.save(XFA_OUT, compress_streams=False)

# ── Verification: a different engine, asking the questions the cases depend on ───────────────────────────────────
# Held in a name, not read off a temporary: pikepdf's /Root refers to its owning object, so
# \`pikepdf.Pdf.open(path).Root\` reads a **destroyed** object (measured: "cannot get key '/AcroForm' on object of type
# destroyed") — the temporary is collected before the attribute is reached.
with pikepdf.Pdf.open(XFA_OUT) as xfa_check:
    xfa_packet = "/XFA" in xfa_check.Root.AcroForm
xfa_document = pymupdf.open(XFA_OUT)
report = {
    "xfaBytes": os.path.getsize(XFA_OUT),
    "xfaPacket": xfa_packet,
    # Counted by walking, not with len(): PyMuPDF's page.widgets() is a generator in this version.
    "xfaWidgets": sum(1 for _ in xfa_document[0].widgets()),
    "bytes": os.path.getsize(OUT),
    "pages": None,
    "widgets": 0,
    "fields": [],
    "apStates": {},
    "prefilled": None,
    "highlightHasAppearance": False,
    "highlightInk": 0,
}
readback = pikepdf.Pdf.open(OUT)
document = pymupdf.open(OUT)
report["pages"] = document.page_count
for widget_read in document[0].widgets():
    report["widgets"] += 1
    report["fields"].append({"name": widget_read.field_name, "type": widget_read.field_type_string})
    if widget_read.field_name == "department":
        report["prefilled"] = str(widget_read.field_value)
# Appearance state names, read with pikepdf: a misspelled key is invisible to every other check here, because the
# field still exists, still reports a value, and simply draws nothing.
for field in readback.acroform.fields:
    ap = field.obj.get("/AP")
    if ap is not None and "/N" in ap and isinstance(ap["/N"], pikepdf.Dictionary):
        report["apStates"][field.fully_qualified_name] = sorted(str(k) for k in ap["/N"].keys())
# The highlight, from two directions: its appearance exists, and it actually renders ink in its own box — a stream
# that is present and empty would satisfy the first check alone, and the golden cases assert ink in that region.
with pikepdf.Pdf.open(OUT) as check:
    for annot in check.pages[0].obj.get("/Annots", []):
        if annot.get("/Subtype") == Name("/Highlight"):
            ap = annot.get("/AP")
            report["highlightHasAppearance"] = ap is not None and "/N" in ap
box = BOX["highlight"]
clip = pymupdf.Rect(box["x"], document[0].rect.height - (box["y"] + box["height"]), box["x"] + box["width"], document[0].rect.height - box["y"])
pixmap = document[0].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY, clip=clip)
report["highlightInk"] = sum(1 for value in pixmap.samples if value < 200)
# Field names must NOT be page text: this is the difference between a form and a document with labels on it.
report["pageText"] = subprocess.run(["pdftotext", OUT, "-"], capture_output=True, text=True, check=False).stdout.strip()
report["xfaMarkerInBytes"] = "PDFTOOLS-XFA-DATA" in open(XFA_OUT, "rb").read().decode("latin-1")
print(json.dumps(report))`;

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // The readiness check is per transport on purpose: `docker compose ps` says nothing about a host build, and a
  // missing interpreter is answered by the builder itself, naming the import that failed.
  const where = workerTransport() === 'docker' ? CONTAINER : 'this host';
  if (workerTransport() === 'docker') {
    const ps = await docker(['ps', '--status', 'running', '--services']);
    if (!ps.stdout.split('\n').includes(CONTAINER)) {
      console.error(`${CONTAINER} is not running — \`docker compose up -d ${CONTAINER}\` first`);
      process.exit(1);
    }
  }

  // The heredoc keeps the script off the container's argv, which is what makes a long script passable at all — and the
  // terminator is quoted so the shell hands the Python over untouched.
  const inner = [
    'set -e',
    `mkdir -p ${STAGE}`,
    `python3 - <<'PDFTOOLS_FIXTURE'\n${BUILD_SCRIPT}\nPDFTOOLS_FIXTURE`,
  ].join('\n');

  const plan = planWorkerExec(CONTAINER, {}, inner);
  const builder = Bun.spawn(plan.argv, { cwd: ROOT, env: plan.env, stdout: 'pipe', stderr: 'pipe' });
  const [builtStdout, builtStderr, builtCode] = await Promise.all([
    new Response(builder.stdout).text(),
    new Response(builder.stderr).text(),
    builder.exited,
  ]);
  const built = { code: builtCode, stdout: builtStdout, stderr: builtStderr };
  if (built.code !== 0) {
    console.error(`the form fixture could not be built in ${where}:\n${built.stdout.trim()}\n${built.stderr.trim()}`);
    process.exit(1);
  }

  const line = built.stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith('{'))
    .pop();
  if (!line) {
    console.error(`the builder printed no report:\n${built.stdout.trim()}`);
    process.exit(1);
  }

  const report = JSON.parse(line) as {
    bytes: number;
    pages: number;
    widgets: number;
    fields: Array<{ name: string; type: string }>;
    apStates: Record<string, string[]>;
    prefilled: string | null;
    pageText: string;
    highlightHasAppearance: boolean;
    highlightInk: number;
    xfaBytes: number;
    xfaPacket: boolean;
    xfaWidgets: number;
    xfaMarkerInBytes: boolean;
  };

  // Assertions, not printouts: a fixture that is missing a field turns a golden case into a test of nothing, and this
  // is the only place where that can be caught before the suite runs.
  const problems: string[] = [];
  // PyMuPDF's `page.widgets()` enumerates *widgets*, so the radio group appears twice under one name — which is the
  // distinction the whole fixture exists to exercise, so the check is on the unique names and the widget count
  // together. A fixture where the radio group had one box would pass a name-only check and fail a case much later.
  const names = [...new Set(report.fields.map((field) => field.name))].sort();
  const expected = ['acknowledged', 'approver_signature', 'department', 'employee_name', 'shift'];
  if (report.pages !== 1) problems.push(`expected 1 page, the read-back found ${report.pages}`);
  if (report.widgets !== 6) problems.push(`expected 6 widgets (the radio group has two), found ${report.widgets}`);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    problems.push(`field names are ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}`);
  }
  if (report.fields.filter((field) => field.name === 'shift').length !== 2) {
    problems.push('the radio group does not read back as two widgets');
  }
  for (const [name, states] of Object.entries(report.apStates)) {
    if (JSON.stringify(states) !== JSON.stringify(['/Off', '/Yes'])) {
      problems.push(`${name}'s appearance states are ${JSON.stringify(states)}, expected /Off and /Yes`);
    }
  }
  if (report.apStates.acknowledged === undefined) {
    problems.push('the checkbox has no appearance map to switch states in');
  }
  if (report.prefilled !== FORM_FIXTURE_PREFILLED.value) {
    problems.push(`${FORM_FIXTURE_PREFILLED.field} reads back as ${JSON.stringify(report.prefilled)}, expected "IT"`);
  }
  if (report.pageText.includes('employee_name')) problems.push('a field name leaked into the page text');
  // The flatten cases assert ink in the highlight's box; a highlight that does not render would make those cases pass
  // against a page where nothing was drawn, which is the failure they exist to catch.
  if (!report.highlightHasAppearance) problems.push('the highlight has no appearance, so no flatten can bake it');
  if (report.highlightInk === 0) problems.push('the highlight draws no ink, so its region cannot be asserted');
  // The XFA twin is only useful if it is the *same form* with a packet added: a case whose warning fires on a document
  // that lost its widgets would prove the warning and nothing else.
  if (!report.xfaPacket) problems.push('the XFA twin has no /XFA packet, so no case could assert the warning');
  if (!report.xfaMarkerInBytes) problems.push(`the XFA packet's ${XFA_PACKET_MARKER} marker is not in the bytes`);
  if (report.xfaWidgets !== 6) {
    problems.push(`the XFA twin reads back as ${report.xfaWidgets} widgets, expected the same 6 as its twin`);
  }

  if (problems.length > 0) {
    console.error(
      `the fixture was built but is not what the cases need:\n${problems.map((p) => `  · ${p}`).join('\n')}`,
    );
    process.exit(1);
  }

  const copied = await copyOut('form-five-fields-a4.pdf', TARGET);
  if (copied.code !== 0) {
    console.error(`could not copy the fixture out of ${where}: ${copied.stderr.trim()}`);
    process.exit(1);
  }
  const copiedXfa = await copyOut('form-xfa-a4.pdf', XFA_TARGET);
  if (copiedXfa.code !== 0) {
    console.error(`could not copy the XFA twin out of ${where}: ${copiedXfa.stderr.trim()}`);
    process.exit(1);
  }

  const written = await stat(TARGET);
  if (written.size !== report.bytes) {
    console.error(`the copied file is ${written.size} bytes, ${where} wrote ${report.bytes}`);
    process.exit(1);
  }
  const writtenXfa = await stat(XFA_TARGET);
  if (writtenXfa.size !== report.xfaBytes) {
    console.error(`the copied XFA twin is ${writtenXfa.size} bytes, ${where} wrote ${report.xfaBytes}`);
    process.exit(1);
  }

  console.log(
    `${TARGET} — ${written.size} bytes, ${report.widgets} widgets over ${report.pages} page, ` +
      `fields: ${names.join(', ')} (verified with PyMuPDF and pikepdf in ${where})`,
  );
  console.log(
    `${XFA_TARGET} — ${writtenXfa.size} bytes, the same ${report.xfaWidgets} widgets with an /XFA packet carrying ` +
      `${XFA_PACKET_MARKER}`,
  );
}

await main();
