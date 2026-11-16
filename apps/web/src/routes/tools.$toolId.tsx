import type { JobResultBody, JobView } from '@pdftools/contracts/api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSession, useToolDefinition } from '../app/providers';
import { Seo } from '../components/Seo';
import { IconChevronDown, IconLayers, IconPen, IconSliders, IconUpload } from '../components/icons';
import { Container } from '../components/layout';
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { DownloadPanel, ProgressPanel } from '../features/download-panel';
import { useJobRunner } from '../features/job-runner';
import { PageCropPreview } from '../features/page-crop';
import { PageOrderPreview } from '../features/page-order';
import { PagePlanPreview } from '../features/page-plan';
import { pagePlan } from '../features/page-plan/plan';
import { PageRotatePreview } from '../features/page-rotate';
import { rotateIdle } from '../features/page-rotate/model';
import { PageSheetsPreview } from '../features/page-sheets';
import { PlacementField } from '../features/placement';
import { SecretReveal } from '../features/secret-reveal';
import { SignInGate } from '../features/sign-in-gate';
import { gateApplies } from '../features/sign-in-gate/gate';
import { OptionsPanel, initialOptionValues } from '../features/tool-shell/options-panel';
import { togglePageSelection } from '../features/tool-shell/page-rows-model';
import { RunFacts } from '../features/tool-shell/run-facts';
import { ToolBanner } from '../features/tool-shell/tool-banner';
import {
  Dropzone,
  FilesBoard,
  acceptAttributeFor,
  boardInputs,
  useClipboardPaste,
  usePageDrop,
  useUploads,
} from '../features/uploader';
import { describeOrder, orderSegments, summarizeOrder } from '../features/uploader/order';
import { getJob, getJobResult } from '../lib/api-client';
import { noIndexSeo, toolSeo } from '../lib/seo';

/**
 * The single tool page template (`docs/0-FOLDER-STRUCTURE.md` §3, `routes/tools.$toolId.tsx`).
 *
 * Every tool renders from this one route: the accept-list, the file ceiling, the options, and the output shape all
 * come from the catalog entry. Adding a tool to the registry therefore adds a working screen with no frontend
 * change at all — which is the point of shipping the `optionsUi` metadata from the server.
 *
 * Three decisions shape the screen (`0-UI-DESIGN.md` §3.2):
 *
 *  - **Choosing files happens anywhere.** The drop zone is a target you aim at; the page listens for a drag as well,
 *    and an overlay says so before the mouse button is released, because "drop it on the page" is what people try
 *    first and a silent no-op is the worst answer to it. `Ctrl/Cmd+V` works from the clipboard too.
 *  - **The file list is the order.** One board holds the uploads and the arrangement, with the page spans the order
 *    produces underneath them, instead of a second list of the same files a few centimetres lower.
 *  - **The facts about a run live behind a `ⓘ`.** Output type, pool limits, plan ceilings and retention are read
 *    once and were costing a card above the button on every visit. The `ⓘ` is written once and drawn in the two places
 *    the reader is in (`features/tool-shell/run-facts.tsx`): the banner while the page is empty, and the studio's own
 *    foot once a document is in the session — because the banner is unmounted the moment one lands.
 *
 * And one decision about the shape of the screen as a whole: **the job is one card, and it is the whole width.**
 * Files and options were two cards in a column, which made a form of one thing look like two unrelated things — the
 * choice of output format sat under a card boundary from the files it applies to, and the boundary is what people read
 * as "this is a different step". They are the same request, so they are the same card, with the options collapsed
 * behind a toggle for the many runs where the defaults are right. The category and pool badges are gone with it:
 * `Organize` above the title repeats what the sidebar is already showing, and `light pool` is a fact about our queue,
 * not about the work.
 *
 * The run control sits *under* that card rather than beside it, in a row of its own. A card column beside a files grid
 * cost the board a third of its width to hold one heading, one progress bar and one button — and the button it held
 * was the last thing on the page to know whether the job could start, since the alerts that say why it cannot live
 * next to the button. Full width, the button is no further away and the documents get the pixels. The banner above
 * carries the tool's identity, so the heading is in the flow and the form starts where the eye already is.
 */
export function ToolRoute() {
  const { toolId } = useParams<{ toolId: string }>();
  const tool = useToolDefinition(toolId);
  const { me, catalog } = useSession();

  const planMaxFiles = Math.min(tool?.input.maxFiles ?? 1, catalog?.plan.maxFiles ?? 1);
  const planMaxFileMb = tool?.input.maxFileMb ?? catalog?.plan.maxFileMb ?? 50;
  const acceptAttribute = acceptAttributeFor(tool?.input.accepts ?? ['application/pdf']);

  const uploads = useUploads({
    maxFiles: planMaxFiles,
    maxFileMb: planMaxFileMb,
    acceptAttribute,
  });
  const { items, files, order, orderedFiles, reorder, addFiles, reset: resetUploads } = uploads;

  const [values, setValues] = useState<Record<string, unknown>>(() => initialOptionValues(tool));
  // Options are open by default and stay open while the tool is on screen: a collapsed form that hides a setting the
  // user needs is worse than a taller card, and the toggle is here for the repeat visitor who never touches them.
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [result, setResult] = useState<JobResultBody | null>(null);
  // The real job row, fetched once the job completes: the download URL, the retention deadline, and the output
  // name are the server's to state, not something this screen should re-derive by hand.
  const [finished, setFinished] = useState<JobView | null>(null);
  const runner = useJobRunner();
  const narrow = useNarrowViewport();

  // A new tool means a new form: keeping the previous tool's options would submit values the schema rejects.
  //
  // The dependency is the catalog *entry*, not `tool?.id`, because the options metadata lives on the entry — if a
  // reload hands back different options for the same id, the form must be rebuilt around them. Depending on the
  // entry rather than its id is safe precisely because it is referentially stable: `useToolDefinition` finds it
  // in the catalog state, so this effect runs when the tool or the catalog changes and never mid-typing. Same for
  // the two resets, both `useCallback(…, [])` in their own hooks.
  useEffect(() => {
    setValues(initialOptionValues(tool));
    setOptionsOpen(true);
    setResult(null);
    setFinished(null);
    runner.reset();
    resetUploads();
  }, [tool, runner.reset, resetUploads]);

  const jobId = runner.state.jobId;
  const jobStatus = runner.state.status;

  // One fetch, asking for the reveal: this is the screen that shows the value, so this is the one request allowed to
  // carry it. The progress poller keeps calling `getJob` without the flag, which is what keeps a generated password
  // out of every intermediate response along the way.
  useEffect(() => {
    if (!jobId || jobStatus !== 'COMPLETED') return;
    void getJob(jobId, { reveal: true })
      .then(setFinished)
      .catch(() => setFinished(null));
    getJobResult(jobId)
      .then(setResult)
      .catch(() => setResult(null));
  }, [jobId, jobStatus]);

  const onOptionChange = useCallback((key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  // The field the catalog declares for the order, if it declares one. Its label and hint are what the board is
  // titled with, and its presence is what says "for this tool the arrangement is part of the request".
  const orderField = useMemo(
    () => (tool?.optionsUi ?? []).find((field) => field.control === 'file-order') ?? null,
    [tool],
  );

  //
  // The tool whose arrangement is the pages of one document (`reorder-pages`) — a `page-order` control, and therefore a
  // screen with a board on it rather than a form. All of the keys a `page-order` control declared belong to that one
  // board, so they are collected together: the board writes them from one state (`features/page-order/model.ts`), and a
  // key left out here would be an option the form still holds and the payload still sends.
  //
  const orderArrangement = useMemo(
    () => (tool?.optionsUi ?? []).find((field) => field.control === 'page-order') ?? null,
    [tool],
  );
  const arrangementKeys = useMemo(
    () => (tool?.optionsUi ?? []).filter((field) => field.control === 'page-order').map((field) => field.key),
    [tool],
  );

  // The tool whose angles are owned by the pages themselves (`rotate`) — a `page-turn` control. It is a board rather
  // than a form for the same reason: the value describes pages the page already draws, and one of the two keys used to
  // be a JSON box.
  const turnField = useMemo(
    () => (tool?.optionsUi ?? []).find((field) => field.control === 'page-turn') ?? null,
    [tool],
  );

  // The tool whose box is drawn on the page itself (`crop`) — a `crop-box` control. The screen is a picture of the
  // document with the rectangle the value describes on it, which is the only rendering of four edge insets that a
  // person can check before running anything.
  const boxField = useMemo(() => (tool?.optionsUi ?? []).find((field) => field.control === 'crop-box') ?? null, [tool]);

  // The tool whose options describe a **sheet of pages** (`n-up`) — a `sheet-grid` control. The screen is the sheet,
  // drawn cell by cell from the document's own bytes, and the three options that decide what paper it is — the grid, the
  // orientation and the stock — are drawn as controls beside it (`sheet-grid`, `sheet-paper`).
  const sheetField = useMemo(
    () => (tool?.optionsUi ?? []).find((field) => field.control === 'sheet-grid') ?? null,
    [tool],
  );
  const orderMatters = orderField != null;

  //
  // The tool whose product is **marks on a page** (`edit-pdf`, `annotate`, `sign`) — a `placement` control.
  //
  // It is a screen of its own rather than a card in a column, and the difference is the same one `crop-box` and
  // `sheet-grid` made: the canvas is a stage, not a field. The page draws it, full width, and hands the panel's own
  // controls *into* the canvas's inspector beside the drawing (`features/placement/index.tsx`), so the toolbox, the page
  // and the settings that describe a mark are all in one screen — which is what makes it an editor rather than a form
  // with a picture above it.
  //
  const placementField = useMemo(
    () => (tool?.optionsUi ?? []).find((field) => field.control === 'placement') ?? null,
    [tool],
  );
  const studioTool = placementField != null;

  // The count on the Options toggle, and whether there is a toggle at all: `file-order` and `page-order` are the
  // boards' own controls and are drawn there, so counting them would name settings the reader cannot find in the section.
  const optionCount = useMemo(
    () =>
      (tool?.optionsUi ?? []).filter(
        (field) =>
          field.control !== 'file-order' &&
          field.control !== 'page-order' &&
          field.control !== 'page-turn' &&
          field.control !== 'crop-box' &&
          field.control !== 'sheet-grid' &&
          field.control !== 'sheet-paper' &&
          // A `placement` field is the studio's own column when the page draws it, so counting it would name a setting
          // the reader cannot find under the Options heading.
          field.control !== 'placement' &&
          !field.advanced,
      ).length,
    [tool],
  );

  const rows = useMemo(() => boardInputs(items, order, files), [items, order, files]);
  const segments = useMemo(() => (orderMatters ? orderSegments(order, files) : []), [orderMatters, order, files]);
  const summary = useMemo(() => summarizeOrder(order, files), [order, files]);

  //
  // The tools that take **one** document and decide *pages* from it get a different screen from the ones that take a
  // set of documents and decide *order* from them, and the catalogue is what says which is which: a `pages`,
  // `page-rows` or `range-groups` control means the options choose pages, and one input means there is a document to
  // draw them on. Thirteen tools meet both conditions, and for those the preview is the *outputs* — which pages go in
  // which file, and what no file gets — because that is the question the form is asking. A merge keeps the board,
  // because there the inputs are the product.
  //
  const selectionField =
    (tool?.optionsUi ?? []).find(
      (field) => field.control === 'pages' || field.control === 'page-rows' || field.control === 'range-groups',
    ) ?? null;
  //
  // A `page-order` tool is the same screen with a different right-hand column: the pages are arranged rather than
  // selected, so there is no plan to draw and no options of its own — the board *is* the options.
  //
  const arrangeDocument = tool != null && tool.input.maxFiles === 1 && orderArrangement != null;
  const turnDocument = tool != null && tool.input.maxFiles === 1 && turnField != null;
  const cropDocument = tool != null && tool.input.maxFiles === 1 && boxField != null;
  const sheetDocument = tool != null && tool.input.maxFiles === 1 && sheetField != null;
  const singleDocument =
    arrangeDocument ||
    turnDocument ||
    cropDocument ||
    sheetDocument ||
    (tool != null && tool.input.maxFiles === 1 && selectionField != null);
  const plan = useMemo(
    () =>
      singleDocument && !arrangeDocument && !turnDocument && !cropDocument && !sheetDocument && tool
        ? pagePlan({ toolId: tool.id, values, pageCount: files[0]?.pages ?? null })
        : null,
    [singleDocument, arrangeDocument, turnDocument, cropDocument, sheetDocument, tool, values, files],
  );

  // The arrangement the board means, written into the form in one patch: the keys are one arrangement, and a write that
  // touched only `order` would leave a `reverse: true` behind for `slotsFromOptions` to apply a second time. The patch is
  // merged rather than assigned, so a key the new form replaces has to be in it as `undefined` — which is why
  // `rotatePatch` returns the whole surface and not only the keys it uses (`features/page-rotate/model.ts`).
  const applyArrangement = useCallback((patch: Record<string, unknown>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

  //
  // A page clicked in the preview, moved to the other half (`extract-pages`, `delete-pages`).
  //
  // The whole operation is "the value changes", and the arithmetic is the tested module's: the page set toggles, spelled
  // back as specs, and an empty set goes back to `undefined` — the same convention the rows control uses, so the two
  // controls write the identical value and the API's "no selection means every page" reading is preserved. Which way the
  // page moves is not a parameter: a page in the removed half becomes kept, and a page in the kept half becomes removed,
  // and the half the click came from already said which.
  //
  const movePage = useCallback(
    (page: number) => {
      if (!selectionField) return;
      const next = togglePageSelection({
        value: values[selectionField.key],
        page,
        pageCount: files[0]?.pages ?? null,
      });
      if (next == null) return;
      setValues((current) => ({ ...current, [selectionField.key]: next.length > 0 ? next : undefined }));
    },
    [selectionField, values, files],
  );

  const payload = useMemo(() => {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
      clean[key] = value;
    }
    // A `file-order` control is the catalog's way of saying "this option is the file list itself".
    if (orderField && order.length > 0) clean[orderField.key] = order;
    return clean;
  }, [values, order, orderField]);

  if (!tool) {
    return (
      <>
        <Seo
          meta={noIndexSeo(
            `/tools/${toolId ?? ''}`,
            'Tool not found',
            'That tool does not exist in this build. Browse the catalog for everything supported.',
          )}
        />
        <Container>
          <div className="page stack">
            <Skeleton width="30%" height={22} />
            <Skeleton width="60%" />
            <Card className="card-pad">
              <EmptyState
                title={catalog ? 'That tool does not exist' : 'Loading the catalog…'}
                description={
                  catalog ? 'It may have been renamed. The catalog lists everything this build supports.' : undefined
                }
                action={
                  catalog ? (
                    <Link className="btn btn-secondary btn-sm" to="/tools">
                      Browse all tools
                    </Link>
                  ) : null
                }
              />
            </Card>
          </div>
        </Container>
      </>
    );
  }

  const notAvailable = !tool.available || !tool.enabled;
  // A gated caller sees the tool, its options, and what a job would cost — but not a form that ends in a 401. The
  // API is the authority here (`POST /files` refuses too); this only keeps the screen from promising otherwise.
  const gated = gateApplies(me);
  const enoughFiles = files.length >= Math.max(1, tool.input.minFiles);
  //
  // `rotate`'s Run waits for the first turn.
  //
  // This tool's option surface cannot say "no rotation" — `angle` is 90, 180 or 270 and the schema's `default: 90`
  // turns every page of an empty request — so a form with nothing named in it would submit `{}` and rotate the
  // document the board has just drawn upright. The board refuses that state in its own summary ("Nothing turns yet:
  // …"), and the sentence and the button are the same predicate rather than two readings of it: `rotatePatch`
  // is idle for exactly the state the footer is warning about, and the drawing comes from the same module
  // (`features/page-rotate/model.ts`, `rotateIdle`).
  //
  const turnIdle = turnDocument && rotateIdle(values, files[0]?.pages ?? null);
  const canSubmit =
    !gated &&
    !notAvailable &&
    enoughFiles &&
    !uploads.uploading &&
    files.length > 0 &&
    !runner.state.submitting &&
    !turnIdle;
  // Field-level rejections from the API (`details.issues`) so a bad option points at its own control.
  const issueList = runner.state.failure?.issues ?? [];

  const acceptLabel = tool.input.extensions.map((extension) => extension.toUpperCase()).join(', ');
  const capacityReached = items.length >= planMaxFiles;
  const canAdd = !gated && !notAvailable && !capacityReached;
  const lockedInputs = rows.filter((row) => row.encrypted && row.position != null).length;

  const submit = () =>
    void runner.submit({
      tool: tool.id,
      files: orderedFiles.map((file) => file.id),
      options: payload,
    });

  // Every upload finished and the API accepted it — the fact the per-file `Ready` badges used to state once per tile.
  const allReady = items.length > 0 && items.every((item) => item.state === 'done');

  const dropHint = gated
    ? 'Sign in to add files — the upload is refused without an account on this installation.'
    : capacityReached
      ? `The limit on your plan is ${planMaxFiles} file${planMaxFiles === 1 ? '' : 's'}.`
      : `Drop anywhere on this page, or paste · ${tool.title} takes ${
          tool.input.minFiles === tool.input.maxFiles
            ? tool.input.minFiles
            : `${tool.input.minFiles}–${tool.input.maxFiles}`
        } file${tool.input.maxFiles === 1 ? '' : 's'}.`;

  return (
    <>
      <Seo
        meta={toolSeo({
          id: tool.id,
          title: tool.title,
          summary: tool.summary,
          category: tool.category,
          maxFiles: tool.input.maxFiles,
          extensions: tool.input.extensions,
        })}
      />
      {/* The studio takes the wide container: a page being edited is a page, and the 1180px form width is a measure for reading rather than for drawing. Every other screen keeps it. */}
      <Container wide={studioTool}>
        <div className="page stack" style={{ gap: 20 }}>
          {/*
          The banner is the tool *described*; a page being edited is the tool *being used* — so it steps out of the
          drawing's way as soon as a document is in the session, which is the trade full screen makes one level up
          (`0-E2E-CHECKLIST.md` §45 for the bar, §47 for this).

          The measurement behind it, at 1440 × 900 in the studio state: `.tool-hero` is **205 px** tall — 300 px at 390
          wide — visible, and topmost at its own centre, while the document is 1429 px against a 900 px viewport, so
          every one of those pixels is a pixel of the page below the fold. It is **unmounted rather than hidden**: a
          screen reader should not be told about a hero that is not on the screen.

          And the one control inside it is not unmounted with it. The `Before you run it` facts go to the studio's own
          foot as well (`PlacementField`'s `facts` below), because the plan ceiling and the retention window are what a
          run is measured against — the state that *starts* a run, not the empty page that introduces the tool (§48).
          One component states them both times (`features/tool-shell/run-facts.tsx`), so the two cannot drift.
        */}
          {(!studioTool || items.length === 0) && (
            <ToolBanner tool={tool} aside={<RunFacts tool={tool} me={me} catalog={catalog} />} />
          )}

          <div className="stack" style={{ gap: 20 }}>
            {arrangeDocument && orderArrangement ? (
              <PageOrderPreview
                rows={rows}
                values={values}
                keys={arrangementKeys}
                label={orderArrangement.label}
                hint={orderArrangement.hint}
                title={tool.title}
                accept={acceptAttribute}
                acceptLabel={acceptLabel}
                maxFileMb={planMaxFileMb}
                dropHint={dropHint}
                multiple={false}
                // Two questions, two answers: the drop target is full once this tool's one file is in (`capacityReached`
                // is true from that moment for a single-input tool), and the arrangement is only locked by the gate.
                disabled={gated || capacityReached}
                locked={gated}
                rejections={uploads.rejections}
                onFiles={addFiles}
                onRemove={uploads.removeItem}
                onRetry={uploads.retry}
                onChange={applyArrangement}
              />
            ) : turnDocument && tool && turnField ? (
              <PageRotatePreview
                tool={tool}
                rows={rows}
                values={values}
                title={tool.title}
                accept={acceptAttribute}
                acceptLabel={acceptLabel}
                maxFileMb={planMaxFileMb}
                dropHint={dropHint}
                multiple={false}
                disabled={gated || capacityReached}
                locked={gated}
                rejections={uploads.rejections}
                files={files}
                order={order}
                onFiles={addFiles}
                onRemove={uploads.removeItem}
                onRetry={uploads.retry}
                onOptionChange={onOptionChange}
                onTurns={applyArrangement}
              />
            ) : cropDocument && tool && boxField ? (
              <PageCropPreview
                tool={tool}
                rows={rows}
                values={values}
                title={tool.title}
                accept={acceptAttribute}
                acceptLabel={acceptLabel}
                maxFileMb={planMaxFileMb}
                dropHint={dropHint}
                multiple={false}
                disabled={gated || capacityReached}
                locked={gated}
                rejections={uploads.rejections}
                files={files}
                order={order}
                onFiles={addFiles}
                onRemove={uploads.removeItem}
                onRetry={uploads.retry}
                onOptionChange={onOptionChange}
              />
            ) : sheetDocument && tool && sheetField ? (
              <PageSheetsPreview
                tool={tool}
                rows={rows}
                values={values}
                title={tool.title}
                accept={acceptAttribute}
                acceptLabel={acceptLabel}
                maxFileMb={planMaxFileMb}
                dropHint={dropHint}
                multiple={false}
                disabled={gated || capacityReached}
                locked={gated}
                rejections={uploads.rejections}
                files={files}
                order={order}
                // The plan's own page ceiling, which the API enforces on the *output* — so a run whose sheet count exceeds
                // it is refused before it is queued, and the board can say so while the layout is still being chosen.
                planMaxPages={me?.entitlements.maxPages ?? null}
                onFiles={addFiles}
                onRemove={uploads.removeItem}
                onRetry={uploads.retry}
                onOptionChange={onOptionChange}
              />
            ) : studioTool && placementField ? (
              //
              // ── The editing studio ────────────────────────────────────────────
              //
              // Three steps, in the order they have to happen, and the screen only offers the one that is next:
              //
              //  1. **The document.** One drop target, the full width, and nothing else — the options that describe marks
              //     on a page are a question about a page that does not exist yet.
              //  2. **The page.** `PlacementField` draws the file, a page to pick and the two ways to render it — this page,
              //     or all of them. One `pdf-to-images` job per page, which is what the panel says out loud before it
              //     spends one.
              //  3. **The studio.** Toolbox, drawing and inspector, side by side, with this tool's remaining options in the
              //     inspector rather than in a card of their own (`renderPlacement={false}` is that handover).
              //
              // The rail that used to sit here — `FilesBoard` for one file, an options toggle, a card per group — is gone
              // rather than collapsed: a one-file tool has one file, and its arrangement is not a thing that can be
              // changed.
              //
              <div className="studio-layout">
                {items.length === 0 ? (
                  <Card className="card-pad upload-card" data-empty="true">
                    <div className="stack">
                      <div className="card-head">
                        <span className="card-head-icon" aria-hidden="true">
                          <IconUpload size={15} />
                        </span>
                        <span className="label">{`Add a document to ${tool.title}`}</span>
                        <span className="tiny faint">
                          {acceptLabel} · {planMaxFileMb} MB
                        </span>
                      </div>

                      <Dropzone
                        onFiles={addFiles}
                        accept={acceptAttribute}
                        multiple={false}
                        disabled={gated || capacityReached}
                        hint={dropHint}
                      />

                      {uploads.rejections.length > 0 ? (
                        <Alert tone="warning" title="That file was not added">
                          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {uploads.rejections.map((message) => (
                              <li key={message} className="small">
                                {message}
                              </li>
                            ))}
                          </ul>
                        </Alert>
                      ) : null}

                      {/*
                      The three steps, said once — before the file, where they are still a plan rather than an
                      explanation of something that has already happened.
                    */}
                      <p className="small muted" style={{ margin: 0 }}>
                        Add the file, render the page you want to work on (or every page at once), and the toolbox opens
                        on it. Every mark is drawn into the page by the engine, and nothing about the document changes
                        until you run the tool.
                      </p>
                    </div>
                  </Card>
                ) : (
                  <Card className="studio-card">
                    <div className="stack-sm">
                      {/* The frame's own header: inset, and separated from what it names by a hairline rather than by a gap. */}
                      <div className="card-head studio-head">
                        <span className="card-head-icon" aria-hidden="true">
                          <IconPen size={15} />
                        </span>
                        <span className="label">{placementField.label}</span>
                        {/*
                        The upload is *finished* — this head is drawn once the API has the file, not once it was chosen —
                        and it is said here rather than inside the canvas because it is a fact about the request rather
                        than about the drawing: the render button below is only honest once it is true.
                      */}
                        <Badge tone="success">Ready</Badge>
                        <span className="tiny faint truncate">{files[0]?.name}</span>
                        {/*
                        One file, and one way to change it. The board this replaced drew the file again beside the drop
                        target — a second list of the same file, with a Remove and a retry on it — when all a one-file
                        tool needs is the way back to the drop target it came from.
                      */}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const item = items[0];
                            if (item) uploads.removeItem(item.localId);
                          }}
                        >
                          Replace file
                        </Button>
                      </div>

                      <PlacementField
                        field={placementField}
                        value={values[placementField.key]}
                        onChange={onOptionChange}
                        files={files}
                        /*
                        The same four facts the banner carried, at the foot of the inspector — the banner above is gone
                        by the time this screen exists, and a plan ceiling nobody can look up while the marks are being
                        placed is the whole defect (§48). The trigger is at the foot of a column with its own scroll, so
                        the panel opens **upward** and is anchored by its **leading** edge: below the trigger is the
                        container's overflow, and to its left is the drawing.

                        And once more for full screen (§49), where the inspector — foot and all — is hidden: that copy goes
                        to the studio's own bar, the row the mode slides back in when the pointer reaches the stage's top
                        edge. It is the other way up for the same reason in reverse: the bar rides the top of a stage that
                        clips its own overflow, so its panel opens **downward**, and the trigger's leading edge is the
                        anchor as well because the trigger sits just past the bar's document chip.
                      */
                        facts={<RunFacts tool={tool} me={me} catalog={catalog} side="above" align="start" />}
                        barFacts={<RunFacts tool={tool} me={me} catalog={catalog} align="start" />}
                        // The head above names this field and the card is its frame, so the field draws neither a second
                        // label nor its own inset (`PlacementFieldProps.framed`).
                        framed
                      >
                        {/*
                        The tool's other options, in the studio's inspector. This is the handover the flag exists for:
                        `flatten` decides what happens to the marks the canvas is drawing, so it belongs six inches from
                        them rather than in a card under the page.
                      */}
                        <OptionsPanel
                          tool={tool}
                          values={values}
                          onChange={onOptionChange}
                          files={files}
                          order={order}
                          renderFileOrder={false}
                          renderPlacement={false}
                        />
                      </PlacementField>
                    </div>
                  </Card>
                )}
              </div>
            ) : singleDocument && plan && selectionField ? (
              //
              // One document, pages chosen from it. **The upload comes first, and it comes alone:** until a document is
              // in, the options that decide its pages have nothing to act on, and a form asking which pages to keep
              // before there are any pages is a question about nothing — it also makes the first thing on the page a
              // decision rather than the one action with no alternative. So the drop target is the whole page, and the
              // two columns appear when it has a document in it (`PagePlanPreview` draws the dropzone itself when there
              // is no input). The options are not behind a toggle once they arrive: they are not a corner of the card,
              // they are the other half of the screen, and the plan redraws with every keystroke in them.
              //
              <div className={items.length > 0 ? 'tool-split' : 'tool-single'}>
                <Card className="card-pad upload-card" data-empty={items.length === 0 ? 'true' : 'false'}>
                  <div className="stack">
                    <div className="card-head">
                      <span className="card-head-icon" aria-hidden="true">
                        <IconUpload size={15} />
                      </span>
                      <span className="label">
                        {items.length > 0 ? 'Your document' : `Add a document to ${tool.title}`}
                      </span>
                      <span className="tiny faint">
                        {acceptLabel} · {planMaxFileMb} MB
                      </span>
                    </div>

                    <PagePlanPreview
                      rows={rows}
                      plan={plan}
                      label={selectionField.label}
                      accept={acceptAttribute}
                      multiple={false}
                      disabled={gated || capacityReached}
                      hint={dropHint}
                      onFiles={addFiles}
                      onRemove={uploads.removeItem}
                      onRetry={uploads.retry}
                      //
                      // A click on a page moves it across: the option value is what changes, so the rows control below
                      // redraws from the same state and the two cannot drift apart. Only where the plan has two sides —
                      // a page of a split's output or a rotate's document has no side to change, and the tile there keeps
                      // doing what it has always done (open the page larger).
                      //
                      onMovePage={plan.halves ? movePage : undefined}
                    />

                    {uploads.rejections.length > 0 ? (
                      <Alert tone="warning" title="That file was not added">
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {uploads.rejections.map((message) => (
                            <li key={message} className="small">
                              {message}
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}
                  </div>
                </Card>

                {items.length > 0 ? (
                  <Card className="card-pad options-card anim-pop">
                    <div className="stack">
                      <div className="card-head">
                        <span className="card-head-icon" aria-hidden="true">
                          <IconSliders size={15} />
                        </span>
                        <span className="label">Options</span>
                        <span className="tiny faint">{selectionField?.label}</span>
                      </div>
                      <OptionsPanel
                        tool={tool}
                        values={values}
                        onChange={onOptionChange}
                        files={files}
                        order={order}
                        renderFileOrder={false}
                      />
                    </div>
                  </Card>
                ) : null}
              </div>
            ) : (
              <Card className="card-pad">
                <div className="stack">
                  <div className="card-head">
                    {/* The same heading shape as the single-document card: a glyph for which half of the page this is. */}
                    <span className="card-head-icon" aria-hidden="true">
                      <IconLayers size={15} />
                    </span>
                    <span className="label">
                      Files ({files.length}
                      {files.length !== items.length ? `/${items.length} ready` : ''})
                    </span>
                    <span className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="tiny faint">
                        {acceptLabel} · up to {tool.input.maxFiles} file
                        {tool.input.maxFiles === 1 ? '' : 's'}
                        {/*
                        The per-file ceiling the catalog publishes is `min(tool, plan)`, and a guest's plan is zero — so
                        printing it here would read "0 MB each", which is true and useless. The size clause is the one
                        number a caller can act on only after signing in, so before then it says exactly that.
                      */}
                        {gated ? ' · your plan’s size limit applies once you sign in' : ` · ${planMaxFileMb} MB each`}
                      </span>
                      {/*
                      One badge for the request, in the corner where a badge belongs. A `Ready` on every tile said the
                      same thing once per file, and on a twenty-file merge that is twenty badges competing with the
                      twenty pages they sit on.
                    */}
                      {allReady ? <Badge tone="success">Ready</Badge> : null}
                    </span>
                  </div>

                  <Dropzone
                    onFiles={addFiles}
                    accept={acceptAttribute}
                    multiple={tool.input.maxFiles > 1}
                    disabled={gated || capacityReached}
                    compact={items.length > 0}
                    // Disabled rather than hidden: the accept-list and the ceiling are worth reading before signing in,
                    // and "nothing happened when I dropped a file" is the failure the hint avoids.
                    hint={dropHint}
                  />

                  {uploads.rejections.length > 0 ? (
                    <Alert tone="warning" title="Some files were not added">
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                        {uploads.rejections.map((message) => (
                          <li key={message} className="small">
                            {message}
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  ) : null}

                  <FilesBoard
                    rows={rows}
                    segments={segments}
                    label={orderField?.label ?? 'Files'}
                    hint={orderField?.hint}
                    reorderable={orderMatters}
                    disabled={gated}
                    onReorder={reorder}
                    onRemove={uploads.removeItem}
                    onRetry={uploads.retry}
                  />

                  {/*
                  One card, two sections, one divider. The options belong to the same request as the files — that is
                  why they are not a card of their own — and the toggle is what keeps that from meaning "a form twice
                  as tall", because most runs are the default.
                */}
                  {optionCount > 0 || tool.optionsUi.length > 0 ? (
                    <div className="job-section">
                      <button
                        type="button"
                        className="section-toggle"
                        aria-expanded={optionsOpen}
                        aria-controls="tool-options"
                        onClick={() => setOptionsOpen((current) => !current)}
                      >
                        <span className="label">Options{optionCount > 0 ? ` · ${optionCount}` : ''}</span>
                        <span className="section-toggle-caret" data-open={optionsOpen} aria-hidden="true">
                          <IconChevronDown size={15} />
                        </span>
                      </button>

                      {optionsOpen ? (
                        <div id="tool-options">
                          <OptionsPanel
                            tool={tool}
                            values={values}
                            onChange={onOptionChange}
                            files={files}
                            order={order}
                            renderFileOrder={false}
                          />
                        </div>
                      ) : (
                        <span className="tiny faint">
                          Using the defaults for{' '}
                          {optionCount === 1 ? 'the only setting' : `all ${optionCount} settings`}. Open to change how
                          this run is done.
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              </Card>
            )}

            {gated ? (
              <Card className="card-pad">
                <SignInGate
                  hint={`Nothing about ${tool.title} changes once you sign in — the file never leaves this installation.`}
                />
              </Card>
            ) : (
              <>
                <Card className="card-pad run-card">
                  <div className="stack">
                    {notAvailable ? (
                      // A gated caller sees this tool as "not in your plan" too, because the catalog computes availability
                      // from a plan they do not have. `!gated` keeps that from becoming a second, competing explanation:
                      // the gate above already says the one thing they need to do. A tool that no worker implements is
                      // still said out loud, because signing in would not change it.
                      <Alert tone="warning" title={tool.enabled ? 'Not in your plan' : 'Not in this build yet'}>
                        <span className="small">
                          {tool.enabled
                            ? `This tool is available from the ${tool.requiresPlan?.join(' or ') ?? 'next'} plan. You are on the free tier.`
                            : `The registry knows about ${tool.title}, but no worker image implements it yet (phase ${tool.phase}).`}
                        </span>
                      </Alert>
                    ) : null}

                    {lockedInputs > 0 ? (
                      <Alert tone="warning" title="One input is password-protected">
                        <span className="small">
                          This tool refuses an encrypted document rather than guessing at it.{' '}
                          <Link to="/tools/unlock">Unlock it first</Link>, then add the unlocked copy here.
                        </span>
                      </Alert>
                    ) : null}

                    {issueList.length > 0 ? (
                      <Alert tone="danger" title="Some options need attention">
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {issueList.map((issue) => (
                            <li key={issue.path} className="small">
                              {issue.path}: {issue.message}
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}

                    {/*
                    The action, in a row of its own: what the job will do on the left, the control that starts it on the
                    right. Previously this was a narrow card column that had to be scanned for a button; at full width
                    the row reads left-to-right exactly once and the button is where the eye already is.
                  */}
                    <div className="run-row">
                      <div className="run-row-copy">
                        <span className="label">Run</span>
                        <span className="small muted">{describeOrder(summary)}</span>
                      </div>
                      <div className="run-row-side">
                        {!enoughFiles && !gated ? (
                          <span className="tiny faint">
                            Add at least {Math.max(1, tool.input.minFiles)} file
                            {Math.max(1, tool.input.minFiles) === 1 ? '' : 's'} to continue.
                          </span>
                        ) : null}
                        {/* On a phone the button lives in the sticky bar below, so exactly one Run control exists at any width. */}
                        {!narrow ? (
                          <Button
                            variant="primary"
                            loading={runner.state.submitting}
                            disabled={!canSubmit}
                            onClick={submit}
                          >
                            {runner.state.submitting ? 'Starting…' : `Run ${tool.title}`}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>

                <ProgressPanel
                  status={runner.state.status}
                  phase={runner.state.phase}
                  progress={runner.state.progress}
                  message={runner.state.message}
                  transport={runner.state.transport}
                  timeline={runner.state.timeline}
                />

                {finished ? (
                  <DownloadPanel
                    job={finished}
                    parts={result?.parts}
                    archiveUrl={result?.archiveUrl}
                    metrics={result?.metrics}
                    // What went in, for the comparison in the panel — the tool page is the only place that still knows.
                    inputs={files.map((file) => ({ pages: file.pages, bytes: file.sizeBytes }))}
                  />
                ) : null}

                <SecretReveal secrets={finished?.secrets} />

                {runner.state.error ? (
                  <Alert tone="danger" title={runner.state.error.code.replaceAll('_', ' ')}>
                    <span className="small">{runner.state.error.message}</span>
                  </Alert>
                ) : null}
              </>
            )}
          </div>
        </div>

        {/* The page-wide drop target's promise, stated before the drop rather than after it. */}
        <PageDropOverlay tool={tool.title} acceptLabel={acceptLabel} enabled={canAdd} onFiles={addFiles} />
        <ClipboardPaste enabled={canAdd} onFiles={addFiles} />

        {narrow ? (
          <div className="run-bar">
            <div className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
              <span className="small strong truncate">{describeOrder(summary)}</span>
              {runner.state.status ? (
                <span className="tiny faint truncate">
                  {runner.state.status.replaceAll('_', ' ').toLowerCase()}
                  {runner.state.progress > 0 ? ` · ${Math.round(runner.state.progress)}%` : ''}
                </span>
              ) : (
                <span className="tiny faint truncate">{gated ? 'Sign in to run' : 'Ready when you are'}</span>
              )}
            </div>
            {!gated ? (
              <Button variant="primary" loading={runner.state.submitting} disabled={!canSubmit} onClick={submit}>
                {runner.state.submitting ? 'Starting…' : `Run ${tool.title}`}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Container>
    </>
  );
}

/** The overlay for `usePageDrop`, split out so the drop listener is subscribed once for the page. */
function PageDropOverlay({
  tool,
  acceptLabel,
  enabled,
  onFiles,
}: {
  tool: string;
  acceptLabel: string;
  enabled: boolean;
  onFiles: (files: FileList | File[]) => void;
}) {
  const dragging = usePageDrop({ enabled, onFiles });
  if (!dragging) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay-card">
        <IconUpload size={26} />
        <span className="strong">Drop to add files to {tool}</span>
        <span className="small muted">{acceptLabel}</span>
      </div>
    </div>
  );
}

/** `Ctrl/Cmd+V` on the page; split out for the same reason — the listener is subscribed once. */
function ClipboardPaste({
  enabled,
  onFiles,
}: {
  enabled: boolean;
  onFiles: (files: FileList | File[]) => void;
}) {
  useClipboardPaste({ enabled, onFiles });
  return null;
}

/**
 * Whether the viewport is narrow enough for the sticky run bar.
 *
 * A media query read through `matchMedia` rather than a CSS-only bar, because the bar *replaces* the in-card button:
 * two `Run …` buttons in the accessibility tree would be two answers to the same question, and a test that clicks
 * "the run button" would have to pick one. At any width there is exactly one.
 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
