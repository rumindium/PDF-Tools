import type { ZodTypeAny } from 'zod';

export type ToolQueue = 'light' | 'office' | 'heavy' | 'ocr';

export type ToolCategory = 'organize' | 'convert' | 'optimize' | 'security' | 'edit' | 'document' | 'ocr';

/** Output kinds the download layer knows how to serve. */
export type OutputKind = 'pdf' | 'image-zip' | 'zip' | 'text' | 'html' | 'office' | 'json' | 'csv';

export interface ToolInputSpec {
  /** MIME families accepted, matched against the *detected* type — never the client's header. */
  accepts: string[];
  /** Display only. Never used for validation. */
  extensions: string[];
  minFiles: number;
  maxFiles: number;
  maxFileMb: number;
}

export interface ToolOutputSpec {
  kind: OutputKind;
  mime: string;
  /** true when the tool can produce N outputs packed into one archive. */
  archive?: boolean;
}

export interface ToolEscalation {
  queue: Extract<ToolQueue, 'heavy'>;
  abovePages?: number;
  aboveBytes?: number;
  aboveFiles?: number;
  /**
   * The time budget the job gets once it has moved to `heavy`.
   *
   * Escalation exists because the work is bigger than the pool it was submitted to, so keeping the light pool's
   * budget would hand the heavy pool a job it is expected to need longer for — `01-MERGE.md` §7 promises 420 s for
   * an escalated merge, and `04-COMPRESS.md` §6 the same for compress. Required whenever `escalate` is set, and
   * asserted to exceed the tool's base budget by the registry test: an escalation that shortens the timeout is a
   * contradiction, not a configuration.
   */
  timeoutSeconds: number;
}

/** The time budget a job runs with, given the pool it ended up in. */
export function effectiveTimeoutSeconds(def: Pick<ToolDefinition, 'limits' | 'escalate'>, queue: ToolQueue): number {
  if (def.escalate && queue === def.escalate.queue) return def.escalate.timeoutSeconds;
  return def.limits.timeoutSeconds;
}

/** Presentation metadata for one option — the UI renders from this, never from its own table. */
export interface OptionsUiField {
  key: string;
  /**
   * `json` is for the structural options that have no flat control — an array of page insertions, a
   * page→angle map. The panel parses the draft and only forwards a value that parses, so a half-typed
   * object never reaches the request body.
   *
   * `signature-pad` is the one control whose *value* is produced by the user rather than typed or picked:
   * a drawing surface that exports an image, uploads it and stores the file id, with a file input beside it
   * for the same option. It names the option it fills (`imageFileId` on `sign`), and it exists because the
   * alternative — declare `drawn` in the schema and leave the drawing to another program — makes the
   * catalog an honest description of an impossible product. A colour, a name and a drawing are not three
   * kinds of the same input; two of them can be typed and one cannot.
   *
   * `range-groups` is `pages` with a **nested** value: one group per output file, which is what `split`'s
   * `ranges` is (an array of arrays). It exists because the flat `pages` control cannot express that at all —
   * it emits `["1-3", "4-8"]` for a schema that wants `[["1-3"], ["4-8"]]`, so every submission of a split in
   * its default mode was refused with `Expected array, received string` while the golden suite stayed green by
   * posting the nested shape by hand.
   *
   * `page-rows` is `pages` with **boxes**: the same flat `string[]`, collected one page or one range per row, each
   * row spelled as `From`/`To` rather than typed as `1-5` — the hyphen is drawn, and an empty `To` is one page, so
   * the half-typed `4-` the grammar refuses is unrepresentable rather than merely rejected
   * (`apps/web/src/features/tool-shell/page-rows.tsx`). It is the control for the tools whose selection *is* the
   * output — `extract-pages` and `delete-pages`, where the rows are a list of what the document is about to become —
   * and for `rotate`, whose selection the board above it **draws**: a row names pages that are visibly turned, and the
   * board writes the same set back, so the boxes and the tiles are one value with two controls. The tools whose
   * selection only says **which pages an option acts on** and draws nothing (the stampers, the exporters) keep the flat
   * text field, where a page list is honestly a list of tokens.
   *
   * `segmented` is `select` for a choice with two or three options and consequences worth showing: the same
   * `choices` rendered as side-by-side cards, each with its own glyph (`choices[].icon`), instead of behind a
   * dropdown. `extract-pages`'s direction is the case it exists for — "Pages to keep" against "Pages to remove" is
   * the first decision on that screen and the one that changes what the rest of the form means.
   */
  /**
   * A comparison table rendered **beneath** the control, for a choice whose consequences are not visible in its own
   * label.
   *
   * `pdf-to-pdfa`'s profile is the case it exists for, and it is a claim the document makes about the UI:
   * `09-PDF-A.md` §2 prints a four-column comparison of PDF/A-1b, -2b and -3b "as shown in the UI". It was not shown:
   * the field rendered three radio labels and the table lived only in the page. Attaching it to the field rather than
   * adding a control kind keeps the registry's own invariant intact — every `optionsUi` key has to exist in the
   * schema — because a table is not an input and has no key to validate.
   */
  comparison?: { columns: string[]; rows: string[][] };
  /**
   * `page-turn` is `rotate`'s, and it is the same argument one tool over: `angle` and `perPage` describe **one** fact
   * about the pages the tool already draws — which way each of them comes out — so the board that draws them is the
   * editor (`apps/web/src/features/page-rotate/`). It replaces a dropdown and a JSON box: the dropdown could not say
   * "page 3 the other way" and the JSON box asked for a map of page → angle by hand. `rotate`'s third key (`pages`) is
   * deliberately **not** this control — it is rows of boxes (`page-rows`, with `turns`), because it is the *target* the
   * board's buttons act on and the same set the board writes back (`selectionFromOptions`).
   *
   * `page-order` is `reorder-pages`' whole option surface — one control kind for **three** schema keys (`order`,
   * `duplicate`, `reverse`).
   *
   * The reasoning is the one that gives `file-order` its shape: an option whose value *is* a thing the page already
   * draws a picture of belongs with that picture, not in a form beside it. Here the value is the output order of the
   * pages and the picture is the pages themselves, so a text box asking for a permutation (`3,1,2,4`) is the one input
   * this tool should never require — it is a sentence about a document the user is looking at. The board in
   * `apps/web/src/features/page-order/` moves those pages and writes all three keys from one state, so the keys are
   * declared here for the registry's invariant (every option has a control) and the panel renders a pointer sentence
   * rather than a second editing surface.
   *
   * `crop-box` is `crop`'s `box`: four insets from the page's edges, in whichever units the user picked, which were the
   * last object in this product still typed as **JSON** — `{ "top": 20, "right": 20, … }` for "trim 20 mm off every
   * side", on a screen that can draw the page it is talking about (`apps/web/src/features/page-crop/`). The units stay
   * an ordinary `select` beside it, because they are a separate question with a separate answer; the box is not, so the
   * board owns the field and this panel gets out of its way.
   *
   * `sheet-grid` is `n-up`'s two **shape** options — `perSheet` and `orientation` — and it is the same rule one tool
   * over: 6 per sheet is a diagram (two columns of three), and the orientation decides which way that diagram lies, so
   * neither is a name without a picture (`apps/web/src/features/page-sheets/`). The tool's other three options —
   * `pageSize`, `gap` and `border` — stay ordinary controls, because they are settings of the sheet rather than facts
   * about its shape; the drawing redraws from all five either way, which is the point of the board.
   *
   * `sheet-paper` is that judgement corrected for `n-up`'s `pageSize`, which was the last of the sheet's options still
   * behind a `select`: a dropdown labelled "Sheet size" whose choices are five names, on a screen that can draw the
   * paper. Whether a stock is A4 or Legal is not a fact about the sheet's *grid*, but it is a fact about the sheet — it
   * sets the paper's ratio (which a diagram shows) and the cell a page gets (which the board now captions every layout
   * with), so the two are drawn as one row of controls beside the drawing rather than split across a form.
   */
  control:
    | 'select'
    | 'segmented'
    | 'toggle'
    | 'number'
    | 'text'
    | 'file-order'
    | 'pages'
    | 'page-rows'
    | 'page-order'
    | 'page-turn'
    | 'crop-box'
    | 'sheet-grid'
    | 'sheet-paper'
    | 'range-groups'
    | 'password'
    | 'json'
    | 'upload'
    | 'placement'
    | 'signature-pad';
  label: string;
  hint?: string;
  default?: unknown;
  choices?: Array<{
    value: string | number | boolean;
    label: string;
    /**
     * A glyph for this choice, from the web app's own icon set (`apps/web/src/features/tool-shell/choice-glyph.ts`).
     *
     * A name rather than a component, because the catalog crosses the wire as JSON — and asserted against that map by
     * a test, so a name nothing resolves fails the build instead of rendering an empty tile
     * (`apps/web/src/features/tool-shell/choice-glyph.test.ts`).
     */
    icon?: string;
    /** One line of consequence under the label, for a choice whose value is not visible in its own name. */
    note?: string;
  }>;
  /**
   * Whether the pages this control collects are the ones the job **removes** — which decides whether the control's own
   * sentence reads `Keeps 3 of 12 pages` or `Removes 3 of 12 pages — 9 stay`.
   *
   * `true` for a tool whose option *is* the removal (`delete-pages`, whose label is `Pages to remove`).
   *
   * `{ key, when }` for a tool where the direction is a second option, which is `extract-pages`: its `mode` is a
   * sibling control, and the same `pages` value means "the output" in one position and "what the output leaves out"
   * in the other. The direction is therefore read from the sibling's current value, and the field names that sibling
   * here rather than the panel guessing it from a choice list called `exclude`.
   */
  removes?: true | { key: string; when: Array<string | number | boolean> };
  /**
   * Whether the pages this control collects are neither taken nor left but **acted on** — the third direction, and the
   * one only `crop` has.
   *
   * `extract-pages` and `delete-pages` divide one document into two, so their selection is an *output* and the sentence
   * under the rows is `Keeps 3 of 12 pages` or `Removes 3 of 12 pages — 9 stay`. `crop` divides nothing: the box is
   * written onto the pages the selection names, and the rest of the document comes back a page with its own crop box
   * untouched — which is the `PARTIAL_CROP` warning the handler emits, said in the form instead. So the sentence is
   * `Crops 3 of 12 pages — the other 9 keep their own crop box.`
   *
   * And an empty selection means the opposite of what it means next door: there is no output to be empty, so no rows
   * is **every page**, which is what the handler does with an absent `pages` and what the field's hint says.
   */
  applies?: true;
  /**
   * Whether the pages this control collects are the ones the job **turns** — `rotate`'s `pages`, and the fourth reading
   * of the same control.
   *
   * Like `applies` this divides nothing: the rotation is written onto the pages the selection names and the pages
   * outside it come back carrying the `/Rotate` they already had — the distinction `PARTIAL_CROP` makes for the crop,
   * one tool over (`workers/light/src/handlers/crop.ts`). What makes it a direction of its own rather than `applies` is
   * the **word**: `Crops 3 of 6 pages` is a lie on a screen whose whole product is an orientation, so the sentence is
   * `Turns 3 of 6 pages — the other 3 keep the rotation they already carry.`
   *
   * And an empty selection is **every page**, as it is for `applies`: the handler rotates with no page selector at all
   * (`--rotate=+90`), which is what the field's hint says.
   */
  turns?: true;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Required by `control: 'placement'`, ignored by the others. */
  placement?: PlacementUiField;
  /**
   * Only show this control when another option has one of these values.
   *
   * `'*'` means "any value at all", which is how an option that depends on an *upload* (`logoFileId`) gates its
   * follow-up controls: a file id cannot be enumerated in advance, so the only meaningful question is whether the
   * user has chosen one yet.
   */
  visibleWhen?: Record<string, Array<string | number | boolean | '*'>>;
  /** Advanced controls collapse behind a disclosure in the tool page. */
  advanced?: boolean;
}

/**
 * What a `placement` control needs from the tool that declares it.
 *
 * Coordinates are the one option family no flat control can express — a keyed object per element, with the page's
 * own origin — so for a long time the only UI for them was the JSON editor. This describes the visual editor that
 * replaces it: a canvas showing the document's own pages with draggable boxes on top.
 *
 * The pages are **rendered by a real job**, and the tool that renders them is named here rather than hard-coded in
 * the canvas. That follows the boundary rule from the other side: the API cannot spawn an engine
 * (`0-FOLDER-STRUCTURE.md` §2, which is why `GET /files/:id/preview` is an honest 501), so a preview that shows what
 * the engines see can only be a worker's output. It also means the canvas cannot disagree with the job it is placing
 * into — both are the same bytes through the same engines.
 *
 * The cost is stated where it is paid: a preview is a job like any other. It is created with a short retention, and
 * it appears in the caller's job history.
 */
export interface PlacementUiField {
  /**
   * How one placed mark is spelled in the option's array, which is the only thing the canvas cannot guess.
   *
   * The shapes diverge in ways a field map cannot paper over: `edit-pdf` puts the box on the entry itself
   * (`x`/`y`/`width`/`height`) and sizes a text mark by its font, `annotate` groups boxes in a `rects` array, anchors
   * a note at a single point and carries a colour per kind, `sign` writes points, millimetres *or* a share of the
   * page, and `redact` spells its rectangles `w`/`h` under a region that may override the job-wide fill. Naming the
   * shape keeps that divergence in one module per shape (`apps/web/src/features/placement/`) instead of in a
   * condition per tool.
   */
  shape: 'edit-elements' | 'annotations' | 'signature' | 'redactions';
  /** Tool id whose output parts are single-page images in page order — `pdf-to-images` today. */
  renderTool: string;
  /**
   * Render resolution for the preview.
   *
   * 96 dpi is ~1.33 px per point: a glyph is legible and one A4 page is ~200 kB, which is the trade a placement
   * preview wants. It is also the scale the geometry uses — every drag is converted back through this number, so it
   * is a contract value rather than a UI preference.
   */
  dpi: number;
  /** Element kinds the toolbar offers, in order. The first is selected when the editor mounts. */
  kinds: string[];
}

/**
 * An extra upload a tool needs that is *not* one of its documents — a watermark image, a logo, a signature.
 *
 * The user names it by file id (they uploaded it and got one back), so resolving it is the API's job: the declared
 * ids are loaded, ownership-checked, and handed to the worker as attachments, in this declaration order. Declaring
 * it here rather than hard-coding the option name in the job service keeps "which options name a file" a property
 * of the tool, next to the schema that says the option exists.
 */
export interface ToolAuxiliaryFile {
  /**
   * Where the file id lives.
   *
   * A plain option key (`watermark.imageFileId`) for an upload the whole job shares, or an element-editor form
   * (`edit-pdf.elements[].fileId`) when the ids sit inside an array option — one per entry, read from the field after
   * the dot. The API's resolver parses that shape (`resolveDeclaredIds` in `apps/api/src/services/job-service.ts`), and
   * the E2E harness fills it from the same declaration, so a case can upload an image element's file without knowing
   * how the option is spelled.
   */
  option: string;
  /** What it is, for the error message when the id is missing or of the wrong type. */
  label: string;
  /** Detected MIME families this attachment accepts. */
  accepts: string[];
}

export interface ToolDefinition<TOptions extends ZodTypeAny = ZodTypeAny> {
  id: string;
  /** Uploads named by option, resolved into worker attachments (`docs/11-WATERMARK.md` §2). */
  auxiliaryFiles?: ToolAuxiliaryFile[];
  /**
   * Option keys whose **values** must never be written down (`docs/0-SECURITY.md` §5).
   *
   * The job row outlives the request, so a password in `jobs.options` is a password in a backup, in the history
   * endpoint and in every dump anyone takes for as long as retention keeps it. Declaring the keys here is what makes
   * that one list decide three things at once: what the API persists (a placeholder), what the queue payload carries
   * (the same placeholder, since BullMQ keeps failed payloads for a day), and what the worker is handed out of band.
   *
   * Both directions are asserted by `packages/contracts/test/registry.test.ts` — a `password` control that is not
   * declared, and a declaration with no option behind it, are both failures — and the keys are top-level only,
   * because `redactSecrets` is a shallow operation by design. Full rules: `./secrets.ts`.
   */
  secrets?: readonly string[];
  /**
   * Which of `secrets` are passwords this tool **chooses**, and so are subject to the strength policy.
   *
   * A second list rather than a flag on `secrets`, because the two answer different questions. `secrets` says "never
   * write this value down", which is true of every password this service touches. This says "this service decides how
   * good this password must be" — true of `encrypt` and `restrict`, which set a password on the document, and false of
   * `unlock`, which is handed a password that already exists on somebody else's file. Refusing to open a document
   * because its owner once chose `1234` would punish the person holding it; `docs/10-PROTECT-AND-UNLOCK.md` §6 states
   * the rule, and the registry test asserts this list is a subset of `secrets` so the two cannot drift apart.
   */
  setsPasswords?: readonly string[];
  /**
   * A rate limit for this tool alone, charged in addition to the per-identity limit every request pays.
   *
   * It lives in the registry rather than in the API's code because it is a property of the *tool* — `unlock` is a
   * password guesser pointed at other people's files, and every other tool in the catalogue is not. A limit written at
   * the call site would have to name the tool anyway, and would then be discovered by whoever reads the endpoint rather
   * than by whoever changes the tool.
   */
  rateLimit?: {
    /** Requests per minute for one identity, refilled continuously by the bucket in `quota-service.ts`. */
    perMinute: number;
    /** Extra instantaneous allowance for callers whose single legal request is several charged requests. `0` here. */
    burst?: number;
  };
  category: ToolCategory;
  queue: ToolQueue;
  escalate?: ToolEscalation;
  title: string;
  summary: string;
  input: ToolInputSpec;
  output: ToolOutputSpec;
  options: TOptions;
  /** Plan tool-gates. Omitted = available to every plan. */
  plans?: Array<'free' | 'pro' | 'business'>;
  limits: {
    timeoutSeconds: number;
    memoryMb: number;
    /** 0 = unlimited (still bounded by the plan's page limit). */
    maxPages: number;
  };
  optionsUi: OptionsUiField[];
  phase: 3 | 4 | 5 | 6 | 7 | 8 | 9;
  enabled: boolean;
}

/** Queue the job would run in, after escalation rules are applied to the claimed sizes. */
export function effectiveQueue(
  def: Pick<ToolDefinition, 'queue' | 'escalate'>,
  claimed: { pages?: number; bytes?: number; files?: number },
): ToolQueue {
  const esc = def.escalate;
  if (!esc) return def.queue;
  if (esc.abovePages != null && (claimed.pages ?? 0) > esc.abovePages) return esc.queue;
  if (esc.aboveBytes != null && (claimed.bytes ?? 0) > esc.aboveBytes) return esc.queue;
  if (esc.aboveFiles != null && (claimed.files ?? 0) > esc.aboveFiles) return esc.queue;
  return def.queue;
}

/**
 * Is this tool both entitled and plan-permitted for the caller?
 *
 * Two independent gates, and **both** must pass — the plan gate is checked first precisely so that a wildcard
 * entitlement cannot override it. A wildcard means "every tool this plan is allowed", not "every tool that
 * exists": the `plans` gate is what survives a mis-seeded entitlement row, and short-circuiting on the wildcard
 * would throw that protection away. `apps/api/src/services/job-service.ts` enforces the same two gates at job
 * creation; this helper exists so any other caller gets the identical answer.
 */
export function toolAllowed(def: Pick<ToolDefinition, 'id' | 'plans'>, planTools: string[], planId: string): boolean {
  if (def.plans && def.plans.length > 0 && !def.plans.includes(planId as 'free' | 'pro' | 'business')) {
    return false;
  }
  return planTools.includes('*') || planTools.includes(def.id);
}

/**
 * The option keys a tool accepts.
 *
 * `options.shape` is `undefined` for any schema that went through `.refine()` (or `.transform()`), because zod
 * wraps those in a `ZodEffects`. That matters: reading `.shape` directly — the obvious thing to do — silently
 * yields `undefined` for `reorder-pages`, `encrypt`, `watermark`, and `header-footer`, and `Object.keys(undefined)`
 * throws. Unwrapping first gives every tool the same, correct answer.
 *
 * The unwrap walks the public `innerType()`/`unwrap()` accessors rather than `_def`, so a zod minor release cannot
 * quietly change the private shape this depends on.
 */
export function optionKeys(def: Pick<ToolDefinition, 'options'>): string[] {
  return Object.keys(optionSchema(def));
}

/**
 * The schema of each option key, unwrapped exactly the way `optionKeys` unwraps it.
 *
 * The registry test needs to ask a second question about a key — not "does it exist" but "what kind of value does its
 * schema accept" — because a control that sends the wrong *kind* is invisible to every other check in this repository:
 * the keys match, the API's schema is valid, the golden suite posts the shape by hand, and only a user typing in the
 * form finds out. That is what happened to `encrypt`'s `permissions` (an object behind a free-text box), and the test
 * that now prevents it is stated against these schemas rather than against a hand-written table of kinds.
 */
export function optionSchema(def: Pick<ToolDefinition, 'options'>): Record<string, ZodTypeAny> {
  // Documented above, and the reason this exists rather than a `.shape` read at each call site.
  const object = unwrapToObject(def.options);
  const shape = (object as unknown as { shape?: Record<string, ZodTypeAny> }).shape;
  return shape ?? {};
}

function unwrapToObject(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const wrapper = current as unknown as { innerType?: () => ZodTypeAny; unwrap?: () => ZodTypeAny };
    if (typeof wrapper.innerType === 'function') {
      current = wrapper.innerType();
      continue;
    }
    if (typeof wrapper.unwrap === 'function') {
      current = wrapper.unwrap();
      continue;
    }
    break;
  }
  return current;
}
