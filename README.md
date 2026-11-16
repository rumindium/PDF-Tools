# PDF Tools

A conversion service: upload a document, get a result, and have the bytes deleted automatically. Structural
work (merge, split, rotate, page edits) is done with **qpdf**; compression and archival output with
**Ghostscript**; office conversion with **LibreOffice**; rendering and text extraction with **MuPDF** and
**Poppler**; table extraction with **Camelot**; recognition with **OCRmyPDF** and **Tesseract**.

The full design lives in [`../Auth-Platform/docs/13-integration/PDF-TOOLS/`](../Auth-Platform/docs/13-integration/PDF-TOOLS/):
architecture, database schema, queue and job lifecycle, per-tool engine recipes, security model, testing strategy,
monitoring, and deployment phases. This README is the short version: how to run it, and what is actually
implemented today.

---

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up -d --build postgres redis api worker-light web
open http://localhost:5180
```

Ports are chosen to sit beside the sibling platforms: **5435** Postgres, **6382** Redis, **8080** API,
**5180** web (the Auth Platform owns 5433/6379/3000/5100, Procurement 5434/6381/4000/5173).

The other three worker pools are separate images — build them when you need them:

```bash
docker compose up -d --build worker-office worker-heavy worker-ocr
```

## Quick start (local, no containers) — 1 command

```bash
node scripts/run-local.mjs
```

Runs `bun install` (unless `--no-install`), `db:migrate`, then API (`:8080`) +
`light` worker pool + vite web (`:5180`). Options: `--pools=light,office,heavy,ocr`,
`--api-only`, `--no-web`, `--no-install`, `--check` (toolchain/ports/engines only).
Needs natively: Bun 1.3.5, PostgreSQL `:5435`, Redis `:6382`, plus engine binaries
per pool (`--check` lists them: qpdf/gs/mutool, soffice, python3/verapdf, ocrmypdf/tesseract).

Manual equivalent:

```bash
bun install
docker compose up -d postgres redis     # just the datastores
bun run db:migrate
bun run fixtures

# Anonymous use has to be asked for. The shipped default is `false` — an installation is
# tenant-first unless an operator says otherwise — and a process with neither an anonymous
# allowance nor an Auth Platform to sign in against refuses to boot rather than answering 401
# to everybody (`docs/0-TENANT-FIRST.md` §3.2–§3.3). Exported once, for the API and the workers
# below, which all read the same configuration. The compose stacks set it themselves.
export ALLOW_ANONYMOUS=true

bun run dev:api                          # :8080, migrates on boot
WORKER_POOL=light bun run dev:worker     # one pool per terminal
bun run dev:web                          # :5180, proxies /api to :8080
```

## Run without Docker (rootless)

```bash
scripts/noroot-stack.sh engines     # qpdf, mutool, ImageMagick + the pikepdf/PyMuPDF venv, under $HOME
scripts/noroot-stack.sh up          # postgres :5435, redis :6382, api :8080, worker-light, vite web :5180
scripts/noroot-stack.sh status      # ports, health, and which engines were found
scripts/noroot-stack.sh env         # exports for tools run outside the stack (see below)
scripts/noroot-stack.sh down        # stops everything it started
```

`up` is idempotent, and `--pools=light,office,heavy,ocr` starts more than the light pool — each pool refuses to start
without its engines, which `check` lists (`light=[qpdf,mutool,magick,pdfinfo] office=[soffice]
heavy=[gs,mutool,pdftohtml,pdffonts,pdfimages] ocr=[tesseract,ocrmypdf]`, plus `verapdf` for the heavy pool's PDF/A
validation). The datastores are the same ones the container stack publishes on the same ports, so nothing else in the
checkout needs to know which of the two is running.

Nothing global is installed and no root is used: Bun is expected at `~/.local/lib/bun/bun` (or on `PATH`), the portable
PostgreSQL and the Redis build under `~/.local/lib`, and everything this script creates — cluster, redis dir, job files,
extracted engines, the Python venv, logs — lives under `~/.local/share/pdf-tools`. The `engines` subcommand needs no
root either: it downloads Ubuntu `.deb` files and unpacks them, and installs `pikepdf`/`PyMuPDF` into a venv (the two
handlers that need them, `compress` and `extract-fields`, fail every job without that bridge).

**Verification without Docker.** The E2E readers and the fixture builders measure documents with the engines that
normally live in the worker image, and they reach them through `docker compose exec` when a daemon answers — or, when
there is none, on this host, which is what `env` sets up:

```bash
eval "$(scripts/noroot-stack.sh env)"   # engines/bin + the pikepdf venv on PATH, PDFTOOLS_INSPECT_TRANSPORT=local
bun run fixtures:form                   # builds the form fixture here instead of in worker-heavy
bun run e2e:merge                       # 23 of its 24 cases; the last one needs the heavy pool (see below)
```

The transport is chosen in one place, `scripts/dev/worker-transport.ts`: `docker info` decides, and
`PDFTOOLS_INSPECT_TRANSPORT=local|docker` overrides it. The same helper is what lets `fixtures:form` build a fixture
without a container.

What still wants a container stack, so it is not mistaken for a bug: the other fixture builders (`fixtures:scan`,
`fixtures:images`, `fixtures:encrypted`, `fixtures:large`, `fixtures:compress`, `fixtures:redact`) and everything under
`scripts/ci/` — the golden suite, the falsification and isolation passes — still call `docker compose`. And `e2e:merge`'s
final case sends a 21-file job to the `pdf-heavy` queue, so it needs the heavy pool up: `gs` and poppler are enough for
it, but the heavy worker's boot check expects `verapdf` while `PDFA_VALIDATE` is on (its default — the validator is what
`pdf-to-pdfa` reports conformance with, and `engines` cannot provision it, being a JRE tool). Run that pool with
`PDFA_VALIDATE=false` where there is no validator, which is the same switch the container image built without veraPDF
uses.

## Verify it works

```bash
bun run e2e:merge                        # against http://localhost:8080
```

The command above is the same one the rootless section uses; with `eval "$(scripts/noroot-stack.sh env)"` it runs
entirely on this host — 25 checks, no Docker.

The E2E test generates two PDFs, uploads them, creates a merge job, follows it to completion, downloads the
result, and **parses the downloaded file** to check the page count and the page order independently of what the
API reported. It is the fastest honest answer to "is this stack actually converting?".

Every other tool is held to the same standard by one command, so verifying a tool is not a new script:

```bash
bun run fixtures:scan                                                              # needs the stack up
bun run fixtures:images                                                            # needs worker-light up (ImageMagick and the transparent logo)
bun run fixtures:encrypted                                                         # needs worker-light up (qpdf lives in the image, not on the host)
bun run fixtures:form                                                              # needs worker-heavy up (pikepdf writes the form, PyMuPDF and poppler verify it)
bun run fixtures:redact                                                            # needs worker-heavy up (the tokens are measured with PyMuPDF before the file is written)
bun run e2e:tool -- --tool office-to-pdf --file fixtures/generated/office-to-pdf-report.txt --expect-pages 1
bun run e2e:tool -- --tool ocr --file fixtures/generated/ocr-scan-eng-raster.pdf \
                      --options '{"languages":["eng"]}' --expect-text "OCR fixture"
```

All of those cases, plus one per pool, are declared in `scripts/ci/golden.ts` and can be run as a suite — this is
what CI runs, one pool per job:

```bash
bun run test:golden                # every pool, against http://localhost:8080
bun run test:golden -- --pool ocr  # one pool
```

It writes `e2e/artifacts/golden-<pool|all>.json` — suites, checks, durations, and the cases it could not run with the
reason — and CI uploads that file, failure included.

A CI job always starts from nothing; a developer's machine never does, and that difference has produced two real defects
here (a suite served the image from the previous build, and a fixture generator that only worked on a container an
earlier run had primed). `docker-compose.verify.yml` reproduces the CI shape locally — its own compose project, fresh
volumes, images built for the run, offset ports so the stack you are working in is untouched:

```bash
docker compose -p pdf-tools-verify -f docker-compose.yml -f docker-compose.verify.yml \
  up -d --build --wait postgres redis api worker-light worker-heavy worker-office worker-ocr
DATABASE_URL=postgres://pdftools:pdftools@localhost:5436/pdftools bun run db:seed
COMPOSE_PROJECT_NAME=pdf-tools-verify bun run fixtures      # then :scan, :images, :encrypted, :form, :redact
COMPOSE_PROJECT_NAME=pdf-tools-verify bun run test:golden -- --base http://localhost:8090
```

It reproduces the same 126 suites and the same checks (1 550 today; the run recorded in the docs counted 1 543 when it was
made), and it is also the cheapest place to see the checks work: patch a
behaviour into a running worker (`docker exec` + `docker restart`) and the suite fails on the old behaviour, then
`docker compose ... up -d --force-recreate <service>` puts the image back.

An installation is **tenant-first** unless an operator says otherwise (`docs/0-TENANT-FIRST.md`), and that is a
configuration of this stack rather than a different one, so it is tested as an override:

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.tenant-first.yml"
$COMPOSE up -d --wait --build postgres redis platform-stub api worker-light
DATABASE_URL=postgres://pdftools:pdftools@localhost:5435/pdftools bun run test:tenant-first -- --require-database
$COMPOSE down
```

`platform-stub` answers the Auth Platform's app-config route with a value the compose file states, so the profile's
subject cannot be decided by whatever a real platform on this machine happens to say. Every stage that needs an
anonymous session (`test:golden`, `test:falsify`, `test:limits`, `test:isolation`, `test:load`, `test:placement`,
`test:pdfa`, `test:browser`) stops on this stack with one `STACK GAP:` line and exit code 3 instead of failing every
case — `docs/0-CICD.md` §3.10 is the recipe and how to read that line.

Every case that downloads a PDF also asserts its **structure**, and it asks three readers for it: a byte scan, pikepdf's
object walk and poppler's page tree must agree on the page count, no page object may exist that the tree does not list,
and no form field or annotation may still name a page that is gone. A page object the tree does not list is invisible to
a page count, to a text extraction and to a rendered page — which is how `n-up` used to keep every page it had removed
inside the file (`0-IMPLEMENTATION-STATUS.md` §5, defect 83) — and a dangling reference is invisible even to an object
count. There is no flag for it: it runs wherever a PDF arrives, because the check that found the defect had been written
for something else. Both halves were proven able to fail on files built the pre-fix way before being trusted.

For the tools whose output carries a *claim* about itself, there is a second question worth asking: what did the job
say it did? `scripts/ci/pdfa-metrics.ts` submits one `pdf-to-pdfa` job and prints its `changes`, `metrics.outputIntent`,
`conformance` and warnings, which is how "`OUTPUT_INTENT_WRITTEN`" can be read as a statement about the file instead of
about the intention:

```bash
bun run scripts/ci/pdfa-metrics.ts 3b      # needs the stack up; profile defaults to 2b
```

It refuses to accept a job that ended in anything but `COMPLETED`, a zero-byte download, a PDF whose page count
(read from the bytes) disagrees with the API, an archive with no entries, or output that lost the text it was
supposed to preserve. `bun run fixtures:scan` rasterises the OCR fixture into a page with **no text layer**, which
is what makes the OCR test mean something — the text fixture has a text layer, and OCR is configured to leave
those alone.

```bash
bun run lint             # biome: formatting, lint, and import order (CI fails on it)
bun run typecheck        # tsc across the whole workspace
bun test                 # unit tests, including the document-parity rules and — with the docs checked out — the documents themselves
bun run doc:parity       # every option table in `Auth-Platform`'s fifteen documents against the schemas and the catalog
bun run test:golden      # the per-tool golden suite (needs the stack up)
bun run test:falsify     # break each invariant inside a live container; the case guarding it must fail
bun run test:load        # merge at 20 and 50 files: time per file and per page, plus the upload allowance
bun run test:load -- --lanes 8 --lane-case 50x20   # the same tool submitted by 8 callers at once: drain, p95, throughput
bun run test:isolation   # no pool reaches the network, the refusals stop what the engine really does, no script runs
bun run test:pdfa        # veraPDF is installed, rejects a plain PDF, and agrees with an archival job's own verdict
bun run test:placement   # the placement canvas's coordinates, measured as ink where the mark must be and must not
bun run test:tenant-first # the app-level anonymous switch, on both of its positions (profile: docs/0-CICD.md §3.10)
bun run boundaries       # import-graph rules (apps/api must not reach an engine, etc.)
bun run engines:check    # engine versions in the current environment
bun run sweeper          # run the cleanup sweep once, on demand
bun run secrets:audit    # find job rows holding a password in the clear; -- --scrub fixes them
```

---

## Layout

```text
apps/api           Elysia HTTP service — no conversion engines in the image, by design
apps/web           React + React Router 7 SPA, served by nginx which proxies /api on the same origin
workers/shared     worker runtime: claim, lock, stage, verify, report progress, classify failures
workers/light      qpdf, MuPDF, Poppler, ImageMagick, Ghostscript
workers/office     LibreOffice, one profile per job
workers/heavy      Ghostscript, PDF/A, large-document work
workers/ocr        Tesseract + OCRmyPDF, its own pool because recognition is 10–60× the cost of anything else
packages/contracts the tool registry: ids, zod schemas, `optionsUi`, plan limits, error codes, and `secrets` (the
                   option keys whose values are never persisted) — one source of truth for the API, workers and UI
packages/*         config (env parsing), logger, errors, db (drizzle + migrations), queue (BullMQ), engines
infra/*            Dockerfiles, compose, nginx, caddy, postgres init, redis config
*.yml (root)       docker-compose.yml (dev), .ci.yml (light pool in CI), .prod.yml, .verify.yml (from-scratch run),
                   .tenant-first.yml (accounts required, with a stub platform that states the switch)
scripts/*          fixtures, migrate, seed, sweeper, engine versions, secret audit, boundary check
scripts/ci/*       the import-boundary check, the golden suite (`bun run test:golden`), the falsification stage
                   (`bun run test:falsify`) — a claim passes there when its case *fails* — the three measurement
                   stages no case can express (isolation, the PDF/A validator, the placement canvas's geometry),
                   and the document-parity check (`bun run doc:parity`), which compares every option table in the
                   fifteen documents with the schemas and the catalog and fails when a row is not in the schema or
                   its bound differs
e2e/*              end-to-end specs against a running stack
.github/workflows CI: lint, types, boundaries, unit, golden per pool, falsify, tenant-first on both switch
                   positions, image build, Trivy scan
```

The shape that matters most: **the web app contains no tool knowledge.** Every screen renders from
`GET /api/v1/tools`, which is derived from the same zod schemas the API validates with. Add a tool to
`packages/contracts` and a worker handler, and it appears in the UI with a working form — no frontend change.

---

## What is implemented today

| Area | Status |
|---|---|
| API, queue, workers, SSE progress, cleanup sweeper | working |
| Anonymous sessions + plan/entitlement resolution | working |
| Auth Platform SSO handoff (`/sso/consume`) | endpoint present; requires `AUTH_PLATFORM_URL` |
| `merge`, `split`, `extract-pages`, `delete-pages`, `reorder-pages`, `rotate`, `pdf-to-images`, `images-to-pdf`, `compress`, `page-numbers` | working, each with a golden case that re-reads the output's bytes |
| `watermark` | working, both kinds: text (with `{page}`/`{total}`/`{date}`) and images, whose PNG alpha is asserted to survive as a `/SMask` in the output. Five golden cases |
| `header-footer` | working: two bands of three zones, the page variables, a rule per band, and a logo merged as a second overlay pass because a bitmap cannot keep its alpha through the typesetter. Four golden cases |
| `remove-metadata` | working: removes the `/Info` dictionary, the XMP `/Metadata` stream, and attachments (name tree *and* per-page annotations), re-read afterwards with `pdfinfo` so a field that survived is reported instead of assumed gone. It also reports `ELECTRONIC_SIGNATURE_INVALIDATED`, which is the least obvious place for that sentence: the only thing it changes is the `/Info` a signature's byte range covers |
| `linearize` | working, and verified as a property rather than an exit code: the `/Linearized` hint dictionary must be in the output's first 2 KB, and `qpdf --show-linearization` must be able to walk it |
| `pdf-to-text` | working: `pdftotext` with the page window and both layout modes. Refuses a document with no text layer instead of returning an empty file, and says `ocr` is the tool that will work |
| `html-to-pdf` | working: LibreOffice's HTML import, with `pageSize`/`landscape`/`marginMm` applied by injecting an `@page` rule — the export filter carries no geometry — and a `.zip` bundle extracted with its tree intact so relative assets resolve |
| `crop` | working, and non-destructive by construction: only the `/CropBox` is written, so the golden cases assert the new crop box **and** an unchanged MediaBox — a handler that re-wrote the page would pass the first and fail the second |
| `n-up` | working: pages composed as form XObjects onto sheets, with each page's displayed rectangle read through its own `/Matrix` — which is where a page's `/Rotate` lives, and compensating for it by hand instead rotated every page twice. A composition replaces every source page with a new sheet, so an interactive form cannot survive it: the form dictionary is dropped with `FORM_FIELDS_DROPPED` rather than carried, because keeping it left each of its fields naming a page the tree no longer listed — which kept those removed pages, and their bytes, in the output (two sheets, three page objects; `0-IMPLEMENTATION-STATUS.md` §5, defect 83). Five golden cases, plus a rendered measurement because a text assertion cannot see placement, and the signed/unsigned pair asserts page objects **equal** sheets on both inputs |
| `pdf-to-html` | working: `reflow` is a real transformation (Poppler has no reflowed output — its text is positioned absolutely over a page raster), so the positioning and the raster are dropped and the raster's loss is reported as `PAGE_RASTER_DROPPED`. `fixed` keeps the layout. Images are data URIs or `assets/` inside the archive; a document with no text layer is refused |
| `pdf-to-csv` | working: Camelot in the heavy image (`lattice` for ruled grids, `stream` for whitespace). The header line is the table's own first row — Camelot 2 hands back a synthetic `RangeIndex`, so writing it put a `0,1,2` line above every table. `headerRow: false` cannot be honoured by this engine and says so; no table found is `TABLE_NOT_FOUND` rather than an empty file |
| `pdf-to-office` | working, all three targets: `docx` via `pdf2docx` (with `keepLayout: false` routing to a `python-docx` paragraph builder, proved by the *absence* of `<w:tbl>`), `xlsx` via Camelot + `openpyxl`, `pptx` as a page image per slide with real text boxes on top. A non-contiguous selection on the `docx` branch is widened to its span and reported as `SELECTION_WIDENED`; an all-image selection is refused as `IMAGE_ONLY_PAGES`. Six golden cases |
| `office-to-pdf`, `ocr` | working (their own images), golden cases per pool |
| `pdf-to-pdfa` | working, all three levels. Four golden cases, run through the dev plan override that grants Pro. The archival **output intent** is written per job (Ghostscript's `-dPDFA` alone only writes the XMP claim) and then **read back out of the produced file** before the job reports it — raw bytes and inflated object streams, because PDF/A-2 and -3 keep that dictionary in a `/Type /ObjStm` stream. `profile` maps to `-dPDFA=1/2/3` literally, and a colour-managed run asks for `sRGB` because `pdfwrite` cannot honour `UseDeviceIndependentColor` above PDF/A-1 (it reverts per page and still exits 0). **Conformance is validated, not assumed**: the heavy image ships veraPDF (18 MB, CLI pack only) and every job runs it against the produced file. The verdict travels in `metrics.conformance` with the validator's version, and a rejection **withholds the output** (`PDFA_CONFORMANCE_FAILED`) — an archival file that does not conform is worse than no file, because an archive finds out years later. `bun run test:pdfa` reproduces the claim independently, and once proved the validator returns 0 for anything by handing it a plain PDF |
| `edit-pdf` | working, and it reports `ELECTRONIC_SIGNATURE_INVALIDATED` when the document arrives signed (a `/ByteRange` covers the file's bytes; drawing into the page breaks it). `elements` is edited on a **placement canvas** rather than in a JSON textarea: the catalog declares `control: 'placement'` with the tool that renders the page (`pdf-to-images`, a real job — the API cannot spawn an engine), and every drag is converted back into PDF user space by one tested module. `bun run test:placement` measures that arithmetic as ink, at the mark and at its vertical mirror. Five element types over two mechanisms — text, shapes, freehand marks and checkboxes are glyphs and paths through the shared PostScript overlay, images are placed by pikepdf with a matrix — merged onto the pages and never re-rendered. An element naming a page the document does not have is refused rather than skipped, and the marks are burned into the content, so `flatten: false` reports `LAYER_NOT_SEPARATE` and names `annotate` as the tool for marks a reader can select. The unit tests assert the *path* rather than the operator name, because `rect` is a PDF operator and Ghostscript answers it with `Error: /undefined in rect` |
| `encrypt`, `restrict`, `unlock` | working, one pikepdf write between them, and verified by reading the output back with **two** readers. qpdf reports the revision, the cipher and every permission flag; **poppler** — which shares no code with pikepdf — answers the two questions qpdf cannot be asked, because `qpdf --show-encryption` exits 0 with no password and with a wrong one. Six cases: aes-256, aes-128, `restrict` (which must open with *no* password), `unlock` with a user password, with the owner password, and with a wrong one (`WRONG_PASSWORD`, no output written). Passwords reach the engine on **stdin** — `/proc/<pid>/cmdline` is readable by the sibling jobs of other tenants — and the owner password is generated rather than passed through, because an *empty* one protects nothing (qpdf's owner role then opens the document for anyone). The rule is enforced rather than remembered: the worker registers a job's declared values for that job's lifetime and `run()` refuses any argument containing one (`SECRET_IN_ARGV`), and the E2E audit greps the stack's merged container output for them |
| `annotate` | working, it reports `ELECTRONIC_SIGNATURE_INVALIDATED` on a signed input (an added object invalidates a signature exactly as a content edit does), and it is the only tool whose product is a **dictionary** rather than paint: `highlight`/`underline`/`strike` as real annotation dictionaries (one element can carry several rectangles — a three-line selection is three), and `note` as `/Text` with `/Contents` and an author. Every mark carries `/F 4`, so the marks print. The handler reads the produced file back and compares per-subtype counts against what was asked for, which is the only way "we wrote five annotations" is a fact rather than an intention. `flatten: true` draws them into the content at 45 % alpha through an `/ExtGState` instead (Ghostscript cannot do translucency: it answers `setopacityalpha` with `/undefined`), and reports `NOTE_FLATTENED_AS_ICON` because a content stream cannot carry a popup. Four golden cases |
| `extract-fields` | working, and the first tool whose product is **data** rather than a document: the walk reads every page's `/Annots` for `/Subtype /Widget` instead of `/AcroForm /Fields`, because a radio group is *one* field with several boxes and the inherited `/FT`, `/Ff`, `/V`, `/MaxLen` and `/Opt` live up the `/Parent` chain — the golden case pins that with `fields[3].rects[1].xPt`, which can only hold if `/Kids` was followed. Output is JSON (`fields.json`) or CSV; `includeValues: false` **drops the value column** rather than blanking it, because `"value": null` cannot tell an empty field from a field you did not ask about. A document with no form is `NO_FORM_FIELDS` with the OCR suggestion, not an empty file |
| `fill-form` | working: values written as PDF objects (`/V` **and** `/AS` for a box, both naming a state that exists in `/AP /N`), appearances generated for real, then flattened per `flattenMode`. Two measurements shaped it. First, `generate_appearances_if_needed()` is **gated on `/NeedAppearances`** — with the flag absent it wrote nothing, so a filled value sat in `/V`, drew nothing, and was then deleted by the flatten along with its widget: the fix is the two-step a reader performs. Second, `flatten_annotations()` bakes only what has an appearance and leaves everything else in place, so anything it could not bake is **reported** (`FIELD_NOT_FLATTENED`, `EMPTY_FIELDS_REMOVED`) rather than failing a job whose output is correct. `flattenMode: 'filled'` (the default) keeps the fields you did not fill interactive; `'all'` removes an empty field that cannot be drawn. Verified with a **second engine** — PyMuPDF for the widget tree, `pdftotext` once the values are page content. Five golden cases, including the pair that pins `ELECTRONIC_SIGNATURE_INVALIDATED`: reported when the document carries a signature **value**, silent when all it carries is an empty `/FT /Sig` placeholder |
| `sign` | working, and it produces **ink, not a certificate**: the typed branch is typeset by Ghostscript (the `script` family is URW's chancery, embedded as a subset), the drawn/uploaded branch is a bitmap placed by pikepdf with its alpha kept as an `/SMask` **and its aspect ratio kept** (`fit: 'contain'` — a signature squeezed into a box someone dragged is a different signature), and the signer, reason, place and time go into `/Info`. The claim is enforced rather than documented: the handler reads the output back and **fails the job** if it finds a `/Type /Sig`, an `/FT /Sig`, a `/ByteRange` or a `/Perms`, and every success carries `NOT_A_DIGITAL_SIGNATURE`. Six golden cases, one of which asserts the *absence* of those four markers from the downloaded bytes |
| `redact` | working, and the only tool whose product is an **absence** — which is why the verification *is* the tool. PyMuPDF removes the glyphs, images and touched vector art under each mark; the job then reads the output back with **poppler limited to each rectangle** and searches the file's raw and inflated bytes for the strings that occurred *only* inside those rectangles, and a rectangle whose text reads back unchanged or a token that is still findable **fails the job**. `removeContent: false` is a real branch: the box is painted, the text still extracts, and `REDACTION_NOT_REMOVED` says so. Nine golden cases |
| Every other tool | implemented — the registry has **no stub left in it** (both `notImplemented` fallbacks were deleted rather than left unreachable). Every tool that hands the same document back with different bytes — fifteen of them, from `redact` and `edit-pdf` through `rotate`, `crop`, `n-up`, `watermark`, `header-footer`, `page-numbers`, `linearize`, `compress`, `encrypt` and `restrict` — reports `ELECTRONIC_SIGNATURE_INVALIDATED` from one shared sentence, each asserted **and** asserted absent on the same document without a signature. The tools that stay silent do so by design: the page-composition family (`merge`, `split`, `extract-pages`, `delete-pages`, `reorder-pages`, `images-to-pdf`) returns a *different* document assembled from pages, and `unlock` exists to strip encryption from documents whose signature has already stopped mattering |

Three limitations are stated in the product rather than hidden, because each one would otherwise be discovered as
a bug months later:

1. **`split` supports `ranges` and `every-n`.** `by-size` needs a compression loop and `by-bookmarks` needs the
   outline tree, which qpdf does not expose to a CLI caller. Both fail with a message naming what does work.
2. **PDF/A validation is on by default, and the deployment that turns it off gets a warning instead of a verdict.**
   veraPDF 1.30.2 is baked into the heavy image (the digest is pinned in `Dockerfile.workers`; the CLI pack is 18 MB,
   not the ~200 MB the old default was justified by), so `PDFA_VALIDATE=true` is the ordinary configuration and jobs
   carry `metrics.conformance.result: PASS` with the version that produced it. Set it false for an image built without
   the validator — the worker then boots without it, and archival jobs say `CONFORMANCE_NOT_VALIDATED` rather than
   implying a check that did not happen.
3. **`sign` produces a visible signature, not a cryptographic one.** The tool draws ink and records the signer in the
   document's metadata; it writes no signature dictionary, so **nothing in this build can tell that a signed document
   was altered afterwards** — `edit-pdf` can draw over it and `remove-metadata` can drop the record. What the fifteen
   rewriting tools *can* do is warn when the document they were handed already carries a signature (that warning is
   asserted per tool, in both directions); detecting a change made after the fact needs a signature dictionary, and
   PAdES/timestamping is deferred deliberately. That is stated on the tool page, in the API warning every job carries,
   and in the tool docs.

---

## Design decisions worth knowing before changing things

- **The API cannot spawn an engine.** `scripts/ci/check-boundaries.ts` fails the build if `apps/api` imports
  `@pdftools/engines`, and the API image ships without any engine installed. Two enforcements, because this is the
  rule that keeps a web request from becoming an unbounded CPU job.
- **Every rejection happens at job creation.** Tool exists → plan allows it → files owned and typed → size and page
  limits → options schema → quota → concurrency → enqueue. A job that reaches a worker with a bad input is a bug,
  not a user error.
- **The worker re-validates everything**, because a payload can be crafted straight onto the queue. It also
  re-checks the real page count and *escalates the job to another pool* if the submission understated it.
- **Outputs are verified against reality.** A handler declares what it produced; the runtime checks the file exists
  and is non-empty before the job can become COMPLETED. "Success with a 0-byte download" is a failure mode that
  never reaches a user.
- **Progress is written before it is published** (`job_events` then Redis). A client that reconnects with
  `Last-Event-ID` gets the full history from the table, so a dropped connection never loses the completion event.
- **Jobs are anonymous by default.** An opaque session id in an HttpOnly cookie; the row in `sessions` is what
  means anything. No token ever reaches browser storage.
- **A tool's memory budget is a ceiling, not a comment.** `limits.memoryMb` is applied to every spawned engine as
  `RLIMIT_AS`, through util-linux's `prlimit`, which sets the limit and then `exec`s the engine — so the two
  guarantees above survive (no shell, and no secret on a command line). The four worker pools are capped at their
  concurrency times the largest budget in the pool, plus 1 GB for the worker itself, with `pids_limit`, dropped
  capabilities and no-new-privileges (`docs/0-WORKERS.md` §5). On a machine without `prlimit` — a developer's
  laptop — the field is declared and not applied, and `bun run engines:check` says so rather than leaving it to be
  assumed.
- **Cleanup depends on nothing but Postgres and the filesystem** — no queue, no cache, no in-memory timers — because
  its whole job is to handle the case where everything else failed at least once.

---

## Configuration

`.env.example` documents every variable; `packages/config/src/env.ts` is the contract and a bad value fails at
boot rather than mid-job. The ones that change behaviour most:

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | local dev ports | datastores |
| `TEMP_DIR`, `STAGING_DIR` | `/var/lib/pdf-tools/{jobs,staging}` | the only place document bytes live; must share a volume with the workers |
| `JOB_TTL_MINUTES` | 30 | how long a finished result is downloadable |
| `SESSION_SECRET` | dev placeholder | must be replaced outside development |
| `MAX_FILE_SIZE_MB`, `MAX_PAGES_ANONYMOUS` | 50, 200 | anonymous limits; plan limits live in `packages/contracts/src/plans.ts` |
| `PDFA_VALIDATE` | true | validate every `pdf-to-pdfa` output with the veraPDF that ships in the heavy image; a rejection withholds the file. The worker refuses to boot when this is on and `ENGINE_VERAPDF_PATH` points at nothing |
| `ENGINE_VERAPDF_PATH` | `/opt/verapdf/verapdf` (heavy image) | which validator the archival tool calls; empty means "no validator here", and that is only honest with `PDFA_VALIDATE=false` |
| `AUTH_PLATFORM_URL` | empty | empty means anonymous-only mode: no SSO, no permission gate |
