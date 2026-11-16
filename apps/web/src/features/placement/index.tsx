import type { UploadedFile } from '@pdftools/contracts/api';
import type { OptionsUiField } from '@pdftools/contracts/tools';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconCollapse,
  IconExpand,
  IconFileText,
  IconMinus,
  IconPlus,
  IconRedo,
  IconRefresh,
  IconUndo,
} from '../../components/icons';
import { Alert, Badge, Button, Field, SelectInput } from '../../components/ui';
import { ApiError, createJob, getJob, getJobResult } from '../../lib/api-client';
import { useFocusMode } from '../../lib/focus-mode';
import { formatBytes } from '../../lib/format';
import { JsonField } from '../tool-shell/json-field';
import { type PlacementAdapter, type PlacementItem, adapterFor } from './adapter';
import {
  type Box,
  type DisplayGeometry,
  type Point,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT_EM,
  boxFromDisplay,
  centredBox,
  clampBox,
  displayRectFromBox,
  normaliseDraggedBox,
  pageSizeFromPixels,
  pixelsPerPoint,
  textBaselineDropEm,
  textWidthPoints,
} from './geometry';
import { PlacementToolbox, SELECT_KIND } from './toolbox';

/**
 * The placement canvas (`0-UI-DESIGN.md` §6.1, `13-EDIT-AND-ANNOTATE.md` §5).
 *
 * A tool whose options include coordinates — `edit-pdf`'s `elements`, `annotate`'s `annotations` — declares
 * `control: 'placement'`, and this draws its document's own pages and turns drags into those coordinates. Until it
 * existed the only UI for them was a JSON textarea, which meant the product's placement feature was reachable and not
 * usable: a mark's page position is a *visual* fact, and expressing it as two floats plus a guess about which corner
 * the origin is on is how users put a signature in the margin.
 *
 * Four decisions define it:
 *
 * 1. **The page image is a real job.** `pdf-to-images` renders one page per preview, over the same file the caller is
 *    about to edit. The API cannot spawn an engine (`0-FOLDER-STRUCTURE.md` §2), and a renderer in the browser would be
 *    a second pipeline whose output could disagree with the engines' — so the preview is the engines'. The cost is
 *    honest and stated in the UI: a preview is a job, it is created with a short retention, and it appears in history.
 * 2. **The canvas knows nothing about a tool.** Kinds, defaults, how a mark is anchored and which fields it has all come
 *    from the field's declared `shape` (`adapter.ts`); the canvas knows a kind, a page and a rectangle. That is what
 *    lets `annotate`'s markup and `edit-pdf`'s elements share one editor without a condition per tool in here.
 * 3. **The canvas is a convenience, never the only way.** Every number it writes is editable in the list beside it, and
 *    the JSON editor is one click away. That is what keeps dragging from being a *downgrade* for anyone whose mark has a
 *    field the canvas has no control for.
 * 4. **Only the extent is estimated.** A text element's width comes from the shape's own estimate, because the browser
 *    does not have Helvetica's metrics and drawing the string in a browser font would show a glyph run the engine will
 *    not reproduce. Positions, which are what placement is, are exact.
 */
export interface PlacementFieldProps {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  files: UploadedFile[];
  /**
   * Whether the *page* draws this field's frame — its heading and the padded card around it.
   *
   * `edit-pdf`'s studio does: the tool page's own head names the field and the card is the studio's outer box, so this
   * component draws neither the `Field` label (two headings saying "Elements" three centimetres apart was the first thing
   * the served page showed) nor its own inset — the card's frame carries both. Without the flag, the field is a form
   * control inside a form column and draws its own label, which is what a caller that has no frame of its own needs.
   */
  framed?: boolean;
  /**
   * The rest of the tool's own controls, drawn in the studio's inspector beside the drawing.
   *
   * The canvas is a *column*, not a card: a page to draw on needs the width, and the settings that decide what a mark
   * means (`edit-pdf`'s flatten, `sign`'s signer and stamp) belong next to the marks they describe rather than under the
   * page, where they would be a scroll away from the thing they change. The tool page hands them here — the same
   * arrangement the crop and sheet screens already use, where the board is drawn by the page and the form is passed in.
   */
  children?: ReactNode;
  /**
   * The tool page's facts about the run — the `ⓘ` the banner carries (`features/tool-shell/run-facts.tsx`), drawn at the
   * **foot of the inspector** beside the keyboard hint.
   *
   * The editing session is exactly the state the banner leaves in — it is unmounted the moment a document lands — and the
   * plan's page ceiling and the retention window are facts about the run being prepared, not about the empty screen that
   * introduced the tool. So they come here with the other sentences the studio keeps in front of the reader, and the
   * canvas stays ignorant of what they are: it is one more node the page hands in, like `children`.
   */
  facts?: ReactNode;
  /**
   * The same facts, in the one part of the studio **full screen** keeps: the bar.
   *
   * The mode is the drawing, so the inspector goes — and its foot goes with it, which is where the `ⓘ` otherwise lives.
   * The bar is what the mode answers that with: it slides back into the stage whenever the pointer reaches the top edge,
   * so a fact parked in it is one reach away in the state that needs it most. A second node rather than the same one,
   * because the *panel* has to open the other way: the bar rides the very top of a stage that clips its own overflow, so
   * a panel above its trigger would be the stage's own edge cut off (`features/tool-shell/run-facts.tsx`).
   */
  barFacts?: ReactNode;
}

export function PlacementField({
  field,
  value,
  onChange,
  files,
  children,
  facts,
  barFacts,
  framed = false,
}: PlacementFieldProps) {
  const [rawJson, setRawJson] = useState(false);
  const adapter = adapterFor(field);
  const items = adapter?.read(value) ?? [];

  if (!adapter) {
    // A declaration this build cannot draw is a catalog/UI mismatch, and saying so beats rendering a canvas that writes
    // another tool's entry layout — a payload the API would either reject or, worse, accept and ignore.
    return (
      <Field label={field.label} hint={field.hint}>
        <Alert tone="danger" title="This placement shape is not supported by this build">
          <span className="small">
            The catalog declares <code>shape: {String(field.placement?.shape ?? 'nothing')}</code>, which no canvas here
            implements. The option is still editable as JSON.
          </span>
          <JsonField field={field} value={value} onChange={onChange} />
        </Alert>
      </Field>
    );
  }

  //
  // **Both frames are mounted, and one of them is hidden.** The canvas is not unmounted to show the JSON, because what
  // it holds is not a view: the previews it rendered *are* jobs (one `pdf-to-images` render per page, kept thirty
  // minutes) and the history is the session's own gestures. Unmounting to show four lines of text threw both away, so a
  // peek at the value cost a render per page to get back — the studio came back as the preparation panel with `Render
  // page 1` on it (measured on the served page while closing pass 82). `active` is what the hidden canvas is told: it
  // keeps its previews and its history, answers no keyboard and holds no shell state (`PlacementEditor`).
  //
  const canvas = (
    <>
      {
        // The frame the page drew brings no inset of its own to a form (the studio's regions each carry theirs), so the
        // JSON editor is wrapped in one — and in the field's own column the class is a little air around the textarea,
        // which is what a bare textarea inside a label block wants anyway.
      }
      <div className="studio-json" hidden={!rawJson}>
        <JsonField
          field={field}
          value={items.length > 0 ? items.map((item) => item.entry) : value}
          onChange={onChange}
        />
      </div>
      <PlacementEditor
        field={field}
        adapter={adapter}
        items={items}
        active={!rawJson}
        onChange={(next) =>
          onChange(
            field.key,
            next.map((item) => item.entry),
          )
        }
        files={files}
        facts={facts}
        barFacts={barFacts}
      >
        {children}
      </PlacementEditor>
    </>
  );

  //
  // The count, and the way out to JSON. It is the field's own foot in both frames — under the stage inside a card the
  // page drew (`framed`), and inside its own label-and-input column otherwise — and it keeps the *last* word in every
  // state, because hide the toolbox and the list still leaves a placement written as JSON reachable.
  //
  const foot = (
    <div className={framed ? 'placement-foot' : 'row-between wrap'} style={framed ? undefined : { gap: 8 }}>
      <span className="tiny faint">
        {items.length === 0
          ? `No ${adapter.noun}s yet.`
          : `${items.length} ${adapter.noun}${items.length === 1 ? '' : 's'} · ${summarisePages(items)}`}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setRawJson((current) => !current)}>
        {rawJson ? 'Back to the canvas' : 'Edit as JSON'}
      </Button>
    </div>
  );

  if (framed) {
    // No gap between the three pieces: each carries its own inset and its own hairline, so the frame reads as one panel
    // rather than as three boxes with air between them.
    return (
      <div className="placement-framed">
        {canvas}
        {foot}
      </div>
    );
  }

  return (
    // The hint is the canvas's own sentence about dragging and clicking, and it moved *into* the studio's foot when the
    // tool page hands its controls in (`children`): above a full-width stage it was a paragraph between the reader and
    // the page they came to edit.
    <Field label={field.label} hint={children ? undefined : field.hint}>
      <div className="stack-sm">
        {canvas}
        {foot}
      </div>
    </Field>
  );
}

function summarisePages(items: PlacementItem[]): string {
  const pages = [...new Set(items.map((item) => item.page))].sort((a, b) => a - b);
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`;
}

// ─── The canvas ──────────────────────────────────────────────────────────────

interface PagePreview {
  jobId: string;
  part: number;
  status: 'rendering' | 'ready' | 'failed';
  error: string | null;
}

type Drag =
  | { mode: 'create'; kind: string; origin: Point; current: Point }
  | {
      mode: 'move';
      index: number;
      start: Point;
      startBox: Box;
      /** Whether the mark was the selected one when the pointer went down — the second click that opens its words. */
      wasSelected: boolean;
    }
  | { mode: 'resize'; index: number; startRect: { left: number; top: number }; start: Point };

/**
 * The zoom ladder's two ends and its step, as a **factor of fit**.
 *
 * Fit is the one size that is right for every column — the canvas lives in a card whose width is not a constant, so it is
 * measured rather than assumed (`fitScale`, below) — and every other step is a ratio of it: "half again as big as the
 * column I am looking at" is what the user means. A percentage of the file's own pixels would mean a different size on
 * every screen. The reading beside the buttons *is* that percentage, and it is the honest one: the rendered image's
 * pixels on this screen, which the column's width and this factor together decide.
 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

/**
 * How far the pointer may travel and still count as a click.
 *
 * A mark is dragged *and* clicked — a drag moves it, a click on the selected one opens its own words — and the difference
 * is three display pixels of travel rather than a modifier key, because that is the difference a direct-manipulation
 * surface can feel and a modifier is one a user has to be told about.
 */
const CLICK_SLOP_PX = 3;

/** Where the page picker stops offering to render more: a preview job per page, so asking for all of a 500-page
 * document would be 500 jobs. The list is a pagination aid, not a limit — the mark list can name any page. */
const PREVIEW_PAGE_WINDOW = 50;

/**
 * How many gestures the studio remembers.
 *
 * A stack rather than a command log, because the value is an array: an entry is the *whole* previous array, so undo is
 * a single assignment that cannot get out of step with the marks on screen — and the cost of that honesty is why there
 * is a ceiling. Fifty is roughly a minute of placing.
 */
const HISTORY_MAX = 50;

/**
 * How long a burst of field edits stays **one** undo entry.
 *
 * A controlled number or text field writes per keystroke — `items` changes every letter — and an editor whose undo steps
 * back one letter at a time is an editor nobody uses. The burst is closed by a pause rather than by a blur, because a
 * user who types a caption, looks at it, and types one more letter has made one decision.
 */
const EDIT_BURST_MS = 800;

/**
 * How far down-right of its original a pasted mark lands, in screen pixels.
 *
 * A fixed distance *on the screen* rather than a share of the page: at fit the same page edge is hundreds of pixels
 * away, and at 400 % it is a few, so a fraction would be invisible in one case and a leap in the other. It is converted
 * through the same `pixelsPerPoint` the drag uses, so it is the same gesture at every zoom.
 */
const PASTE_OFFSET_PX = 12;

/**
 * How close to the stage's top edge the pointer has to come before full screen's toolbar comes back.
 *
 * Full screen hands the height the bar was using to the drawing, so the bar has to be *asked* for — and a strip is the
 * honest gesture for it: the same reach for the top of the screen that a browser's own full screen and every video player
 * use. Measured from the stage's top edge rather than the viewport's, because the header is chrome this mode keeps.
 */
const BAR_REVEAL_EDGE = 28;

function PlacementEditor({
  field,
  adapter,
  items,
  active,
  onChange,
  files,
  children,
  facts,
  barFacts,
}: {
  field: OptionsUiField;
  adapter: PlacementAdapter;
  items: PlacementItem[];
  /**
   * Whether the canvas is the frame on screen.
   *
   * False while the field's JSON editor is (`PlacementField`), and the canvas stays **mounted** in that state: what it
   * holds — the per-page previews, each a job of its own, and the history of the session's gestures — is exactly what a
   * peek at the value must not cost. `hidden` is the difference the user sees; this flag is the difference a hidden
   * canvas cannot make on its own: it answers no keyboard (a `⌘/Ctrl + Z` in the JSON textarea is *text*), it does not
   * keep the shell's navigation hidden, and it does not leave the stage in full screen.
   */
  active: boolean;
  onChange: (next: PlacementItem[]) => void;
  files: UploadedFile[];
  /** The tool's own controls, drawn in the studio's inspector (`PlacementFieldProps.children`). */
  children?: ReactNode;
  /** The tool page's facts about the run, at the foot of the inspector (`PlacementFieldProps.facts`). */
  facts?: ReactNode;
  /** The same facts in the bar while the mode is full screen (`PlacementFieldProps.barFacts`). */
  barFacts?: ReactNode;
}) {
  const render = field.placement;
  // The catalog decides which kinds exist; the shape decides what to call them. Intersecting the two means a kind the
  // adapter can draw but this tool never declared never appears, and a declared kind the shape does not know is dropped
  // rather than offered as a button that creates an entry the API would refuse.
  const declared = render?.kinds ?? adapter.kinds.map((candidate) => candidate.id);
  const toolbar = adapter.kinds.filter((candidate) => declared.includes(candidate.id));
  const document = files[0] ?? null;
  const [page, setPage] = useState(1);
  // The canvas opens on **Select**: the resting tool, which places nothing (`toolbox.tsx`, `SELECT_KIND`).
  const [kind, setKind] = useState<string>(SELECT_KIND);
  const [selected, setSelected] = useState<number | null>(items.length > 0 ? 0 : null);
  const [zoom, setZoom] = useState(1);
  /**
   * The mark whose words are being typed **on the page**, and the draft being typed into it.
   *
   * The draft is deliberately not the element: every keystroke here would otherwise rewrite the mark, the JSON editor
   * beside it and the payload, and a text field that commits per keystroke cannot be abandoned — Escape would be a
   * slower Enter. So the draft is what the input holds and the element is written once, on blur or Enter.
   */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const { fullscreen, setFullscreen, setSidebarHidden } = useFocusMode();
  /**
   * The toolbar's state in full screen: **whether it is out of the way.**
   *
   * The mode's subject is the drawing, so in full screen the bar stops being a row above the canvas and becomes an
   * overlay that slides out of the top of the stage — the wrap then starts at the stage's own inset instead of 73 px
   * below it. It comes back when the pointer reaches the top strip (below), and by `:focus-within` when a control inside
   * it takes the keyboard, which is what keeps `Tab` from landing on a button nobody can see.
   */
  const [barRevealed, setBarRevealed] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const [previews, setPreviews] = useState<Record<number, PagePreview>>({});
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The stroke still being drawn, by index.
   *
   * A stroke is the one mark that is built up rather than placed: it needs a second click before it has a shape. Holding
   * the index here is what makes those clicks land in the same mark instead of each starting a new one — the alternative
   * (a modal "add point" mode) is how a canvas stops being direct manipulation.
   */
  const [drawing, setDrawing] = useState<number | null>(null);
  /**
   * The bulk render in flight, as `{ request, done, total }`.
   *
   * Rendering a page at a time is the honest unit — one `pdf-to-images` job each — but a ten-page document dropped into
   * the editor is ten round trips the user would otherwise make by hand, one page at a time, waiting each time. The
   * request id is what makes the panel's `Stop` a *cancellation of this run* rather than a global switch that would also
   * silently cancel the next one.
   */
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  /** The run's own cancellation, reset by `renderAll` when it starts — never by the `Stop` that set it. */
  const bulkStop = useRef(false);
  /**
   * Undo and redo, as two stacks of **values** rather than a log of commands.
   *
   * The entry taken by a change is the array *before* it, which is what makes this exact: a placement is an array of
   * objects, and replaying an inverse operation per mark would be a second implementation of every operation — the one
   * place a drag and the value on screen could come to disagree. Both stacks are state rather than refs because the two
   * buttons in the bar are disabled by their depth, and a button that is enabled when there is nothing to take back is
   * a lie about the session's own history.
   */
  const [history, setHistory] = useState<{ past: PlacementItem[][]; future: PlacementItem[][] }>({
    past: [],
    future: [],
  });
  /**
   * The gesture that owns the change happening now, if any.
   *
   * `'drag'` and `'stroke'` are opened by a pointer going down and closed when it comes up (a stroke stays open until
   * the stroke is finished, because its points are separate clicks), and `'edit'` is a burst of field edits closed by a
   * pause. **While one is open nothing pushes a second entry**: the one taken at its start already holds the value
   * before the gesture began, which is exactly what undoing it has to restore.
   */
  const gesture = useRef<string | null>(null);
  /** The timer that closes an `'edit'` burst. Cleared rather than measured: a new edit restarts it. */
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef<Set<number>>(new Set());
  /** Whether this gesture has travelled far enough to be a drag — a click that edits is a click that did not move. */
  const dragged = useRef(false);
  /** Consumed by the next commit, so the blur caused by a cancelled edit's own unmount is not a second commit. */
  const skipCommit = useRef(false);

  const dpi = render?.dpi ?? 96;
  const renderTool = render?.renderTool ?? 'pdf-to-images';
  const preview = previews[page] ?? null;
  const geometry: DisplayGeometry | null = natural
    ? { scale: fitScale * zoom, dpi, page: pageSizeFromPixels(natural, dpi) }
    : null;
  /**
   * How many pages the picker — and `Render all` — will offer.
   *
   * A preview is a job per page, so a five-hundred-page document is not five hundred previews nobody asked for; the
   * window is a pagination aid rather than a limit on the work, because the mark list can name any page at all.
   */
  const totalPages = Math.max(1, Math.min(document?.pages ?? PREVIEW_PAGE_WINDOW, PREVIEW_PAGE_WINDOW));

  // A tool switch (or a catalog edit) can leave the chosen kind outside the declared list. Falling back to the first is
  // the only sensible reading of "the button you had selected is gone" — and `Select` is never a displaced kind, because
  // it belongs to the canvas rather than to the catalogue.
  useEffect(() => {
    if (kind === SELECT_KIND) return;
    if (toolbar.length > 0 && !toolbar.some((candidate) => candidate.id === kind)) setKind(toolbar[0]!.id);
  }, [toolbar, kind]);

  /**
   * One notch up or down the ladder, clamped at both ends.
   *
   * A ratio rather than a list of steps, so that ctrl and a wheel and the two buttons are the same control: the factor is
   * whatever it has been multiplied to, and `Fit` is a button of its own rather than the bottom of the ladder — a user
   * who has zoomed away wants *this column's width* back, not the smallest step that happens to be near it.
   */
  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const next = direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(next.toFixed(3))));
    });
  }, []);

  // ── The history ─────────────────────────────────────────────────────

  /** Take an entry: the array as it stands, and nothing left to redo (a new change forks the future away). */
  const pushHistory = useCallback(() => {
    setHistory((current) => ({ past: [...current.past, items].slice(-HISTORY_MAX), future: [] }));
  }, [items]);

  /**
   * Open a gesture, taking its entry. A drag, however many pointer moves it is made of, is **one** undo.
   *
   * Re-entering the same gesture does nothing, which is what makes this callable from every pointer-down: a stroke's
   * second click, a drag that starts on a mark and passes over another, and a pointer that jitters are all the same
   * gesture as far as the history is concerned.
   */
  const beginGesture = useCallback(
    (label: string) => {
      if (gesture.current === label) return;
      gesture.current = label;
      pushHistory();
    },
    [pushHistory],
  );

  const endGesture = useCallback(() => {
    gesture.current = null;
    if (editTimer.current) clearTimeout(editTimer.current);
  }, []);

  /** A field edit — one entry per burst rather than one per keystroke. */
  const recordEdit = useCallback(() => {
    if (gesture.current) {
      // A drag, a stroke or the burst already being recorded owns this change: its entry exists, and an `'edit'` burst
      // is only extended. Returning here is what keeps a drag from leaving fifty entries behind.
      if (gesture.current !== 'edit') return;
    } else {
      gesture.current = 'edit';
      pushHistory();
    }
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => {
      if (gesture.current === 'edit') gesture.current = null;
    }, EDIT_BURST_MS);
  }, [pushHistory]);

  /**
   * One entry for one action — a button press, a removal, a clear — with no burst to join.
   *
   * A pointer gesture that is open **owns** the change it is making — a drag's fifty moves, a stroke's separate points —
   * so a second entry inside it would make one undo step back half a gesture. A typing burst is the exception, because
   * a button is not part of it: `Clear all` a moment after the last keystroke is a new gesture, and the words typed
   * inside the burst belong to the entry *it* takes. Measured before the distinction was made: the cleared mark came
   * back **without its caption**, because the entry the undo found was the one taken before the burst began (defect
   * 256).
   */
  const recordOnce = useCallback(() => {
    if (gesture.current === 'drag' || gesture.current === 'stroke') return;
    endGesture();
    pushHistory();
  }, [endGesture, pushHistory]);

  /**
   * Remove one mark, and it is **one action however it was asked for**: the row's `Remove` button and the
   * `Backspace`/`Delete` shortcut call this rather than each holding their own copy of it. One entry (`recordOnce`),
   * the value every other gesture writes, and nothing left selected — so one `Ctrl+Z` puts the mark back with its words,
   * which is the only reason a keyboard removal is safe to offer at all.
   */
  const removeAt = useCallback(
    (index: number) => {
      // **An action that changes nothing takes no entry.** `selected` is an index, and an index outlives the array it
      // was taken from: one `Ctrl/⌘ + Z` after a paste leaves it pointing past the end, and a removal there would take a
      // history entry for a mark that is not on the page — so the *next* undo would appear to do nothing at all.
      if (!items[index]) return;
      recordOnce();
      onChange(items.filter((_, at) => at !== index));
      setSelected(null);
    },
    [items, onChange, recordOnce],
  );

  /** The clipboard: one mark, as the value it is — this canvas's, not the platform's (see the keyboard effect below). */
  const clipboard = useRef<PlacementItem | null>(null);

  /**
   * Copy one mark, into the canvas's own clipboard.
   *
   * **A structural copy, not a spread.** A mark is `{ kind, page, entry }` and the entry is the contract's own object
   * carried through whole — which for a stroke is a `points` array and for an annotation is `rects`. A spread would hand
   * the paste the *same* array the original still owns, so editing one would move the other, which is exactly the class
   * of bug a clipboard is supposed to be immune to.
   */
  const copyAt = useCallback(
    (index: number) => {
      const item = items[index];
      // `false` when the index names nothing: a selection can outlive the array it came from (undo after a paste leaves
      // it past the end), and the callers that do more than copy — cut, duplicate — must not go on to act on whatever
      // the clipboard already held.
      if (!item) return false;
      clipboard.current = structuredClone(item);
      return true;
    },
    [items],
  );

  /**
   * Paste the clipboard onto the page being drawn, and select what arrived.
   *
   * Three decisions, and each is a claim about what the gesture means. **On this page**, not on the page the mark was
   * copied from: the canvas is one page, and a paste the user cannot see is a paste that did not happen. **A step
   * down-right**, so the copy does not hide the thing it was copied from — a fixed *screen* distance, converted through
   * the same `pixelsPerPoint` the drag uses, rather than a share of the page that would be invisible at fit and huge at
   * 400 %. **Selected**, so the very next key (an arrow, `Backspace`) acts on the mark the user just made. One entry
   * (`recordOnce`), like `Add` and `Clear all`.
   */
  const paste = useCallback(() => {
    const source = clipboard.current;
    if (!source) return;
    const pageBox = geometry?.page ?? { widthPt: 595, heightPt: 842 };
    const step = PASTE_OFFSET_PX / (geometry ? pixelsPerPoint(geometry) : 1);
    // A mark with no geometry yet — a kind that is placed by its own defaults — lands at the page's centre, which is
    // where `Add` puts one (`centredBox`).
    const box =
      adapter.box(source) ??
      centredBox(adapter.defaultSize(source.kind), { x: pageBox.widthPt / 2, y: pageBox.heightPt / 2 });
    // PDF y grows upward, so "down-right on the screen" is +x and −y in the box.
    const placed = clampBox({ ...box, x: box.x + step, y: box.y - step }, pageBox);
    recordOnce();
    onChange([...items, adapter.move({ ...structuredClone(source), page }, placed)]);
    setSelected(items.length);
  }, [adapter, geometry, items, onChange, recordOnce, page]);

  /**
   * Take the last gesture back.
   *
   * The restored value goes to the same `onChange` every gesture writes to, which is the point: undo is not a second
   * editor with its own copy of the marks, it is the same value with an older array in it — so the drawing, the rows,
   * the JSON editor and the payload all move together, and none of them can be "undone" separately.
   */
  const undo = useCallback(() => {
    const previous = history.past.at(-1);
    if (!previous) return;
    endGesture();
    setHistory({ past: history.past.slice(0, -1), future: [items, ...history.future].slice(0, HISTORY_MAX) });
    onChange(previous);
  }, [endGesture, history, items, onChange]);

  const redo = useCallback(() => {
    const next = history.future[0];
    if (!next) return;
    endGesture();
    setHistory({ past: [...history.past, items].slice(-HISTORY_MAX), future: history.future.slice(1) });
    onChange(next);
  }, [endGesture, history, items, onChange]);

  /**
   * Ctrl/⌘ + Z takes the last gesture back, Ctrl/⌘ + Shift + Z (and Ctrl + Y) puts it forward again.
   *
   * Two things are deliberate. **A new document starts with an empty history** — a stack of arrays belonging to another
   * file would restore marks onto a page they were never placed on. And **an open on-page text field keeps the
   * keyboard**: its draft is not in the history until Enter, so undoing from inside it would change the mark underneath
   * the words being typed, which is the one place a history and a text field can disagree.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A hidden canvas is not the one being typed in, whichever field has the caret — and this handler is the one that
      // takes a `Ctrl/⌘ + Z` from a *caret* on purpose (the undo of a typing burst), which is why the guard is `active`
      // rather than "is the target a field": in the JSON view the same keystroke is the textarea's own undo.
      if (!active || editing != null) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key !== 'z' && event.key !== 'Z' && event.key !== 'y' && event.key !== 'Y') return;
      event.preventDefault();
      if (event.shiftKey || event.key === 'y' || event.key === 'Y') redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editing, redo, undo]);

  /**
   * **The canvas's keyboard, in one handler** — five gestures and one rule, and the rule is why they are one handler:
   * **a keystroke that is being typed is not a command.**
   *
   * The guards come first, so they are stated once rather than remembered per key. `isTypingTarget` keeps every key out
   * of a caret — the row's fields write per keystroke, so `Ctrl/⌘ + V` in the caption field is text and `Backspace`
   * there is a letter — and `editing` is the page's own text field, which holds the keyboard while its draft is being
   * typed (and stops its own `Escape` on the way through, so abandoning an edit never arrives here).
   *
   * - **`Backspace`/`Delete` removes the selected mark**, through `removeAt`: one entry, so `Ctrl/⌘ + Z` brings it back
   *   with its words. With nothing selected it does nothing at all, because there is no mark for `Delete` to mean.
   * - **`Ctrl/⌘ + C`, `+ X` and `+ V` copy, cut and paste one mark**, and **`+ D` duplicates it.** Each is *one entry* —
   *   the action the user made, not the two steps it is made of: cut is a copy and a removal, duplicate is a copy and a
   *   paste, and `Ctrl/⌘ + Z` after either takes back the whole thing.
   * - **`Escape` unwinds one step**: the selection first, and full screen after it. That order is the other reason this
   *   is one handler — a selection is closer to the hand than the mode it is being made in, and two listeners would have
   *   left the order to whichever was registered last (measured: with the mode's own listener alone, one `Escape` over a
   *   selected mark left the stage *and* let go of the mark, which is two answers to one key).
   *
   * The clipboard is **this canvas's, not the platform's**: it holds a mark as the value it is (see `copyAt`), and it is
   * deliberately not `navigator.clipboard` — that is a permission prompt behind a gesture that has to work from the
   * keyboard alone, and a mark is a document-shaped object rather than text. It is cleared with the document, like the
   * history, because a mark copied out of one file is a rectangle on a page this one does not have.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active || editing != null || isTypingTarget(event.target)) return;

      if (event.key === 'Escape') {
        if (selected == null) {
          if (fullscreen) setFullscreen(false);
          return;
        }
        event.preventDefault();
        // The order is this `return`, and the falsification is what says so: with the mode's own listener deleted this
        // pass, dropping a `stopImmediatePropagation()` here left the claims green — there is no second listener left to
        // stop, and letting go of a selection cannot also close the stage it is being made in.
        setSelected(null);
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (selected == null) return;
        event.preventDefault();
        removeAt(selected);
        return;
      }

      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'v') {
        // Paste reads the clipboard, not the selection: a user who let go of the mark and then pasted is the normal case.
        if (!clipboard.current) return;
        event.preventDefault();
        paste();
        return;
      }
      if (key !== 'c' && key !== 'x' && key !== 'd') return;
      if (selected == null) return;
      event.preventDefault();
      // A copy that found nothing ends the gesture here: `cut` and `duplicate` are a copy *and* a second step, and that
      // second step must not happen when the selection has gone stale — a duplicate that pastes whatever the clipboard
      // happens to hold would be an edit nobody asked for.
      if (key === 'c') copyAt(selected);
      else if (key === 'x') {
        if (copyAt(selected)) removeAt(selected);
      } else if (copyAt(selected)) {
        // Duplicate is a copy and a paste, so it leaves the clipboard holding the mark it just copied — the same as
        // copying first would, and one entry instead of two.
        paste();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, copyAt, editing, fullscreen, paste, removeAt, selected, setFullscreen]);

  //
  // A different document is a different history: the previous stack is a set of marks *that* file never had, and
  // restoring one onto a page it was never placed on is worse than having no undo at all. The comparison lives in a ref
  // rather than in the dependency list (`root-layout.tsx` does the same for the route) because the identity of the
  // history is what matters and not the render that noticed it — and because an effect that ran on every render would
  // also clear the history on every render.
  //
  const documentId = document?.id ?? null;
  const historyDocument = useRef(documentId);
  useEffect(() => {
    if (historyDocument.current === documentId) return;
    historyDocument.current = documentId;
    endGesture();
    setHistory({ past: [], future: [] });
    // The clipboard goes with it: a mark copied out of the previous file is a rectangle on a page this one does not
    // have, and pasting it would be an edit the user never watched themselves make.
    clipboard.current = null;
  });

  /**
   * Ctrl/⌘ + wheel zooms the page under the pointer.
   *
   * A **native** listener with `passive: false`, and that is not a preference: React attaches `onWheel` at the root as a
   * passive listener, so a `preventDefault` inside a React handler is ignored — the canvas would zoom and the browser
   * would zoom the whole page along with it, which on a trackpad reads as the app jumping under the hand.
   *
   * `stepZoom` and not the zoom factor: the handler asks for a *direction*, so the effect is not re-attached — and the
   * listener not thrown away and re-added mid-gesture — on every notch.
   */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      stepZoom(event.deltaY < 0 ? 1 : -1);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [stepZoom]);

  /**
   * Full screen is its own viewport, so the page behind it does not scroll.
   *
   * The stage is pinned under the header (`styles/globals.css`), and a document that scrolled under it would drag the
   * header — the one piece of chrome the mode deliberately keeps — along with everything else. Restored on the way out,
   * including when the canvas unmounts inside the mode.
   */
  useEffect(() => {
    if (!fullscreen) return;
    // `window.document`, not `document`: this component has a local `document` — the uploaded file the canvas draws — and
    // the shadowing is silent here, since a file has no `body` and the effect would simply throw.
    const { body } = window.document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [fullscreen]);

  /**
   * The gesture that brings the bar back: a pointer at the top of the stage.
   *
   * The listener is on the window rather than on the stage, because the pointer has to be able to arrive from the header
   * above it, and `pointerdown` rides along with `pointermove` for the touch screen, where there is no hover and a tap is
   * the only "here". Both edges are measured at the moment of the event rather than kept in state: the bar's own height
   * is a number this component does not own (its row wraps at narrow widths).
   */
  useEffect(() => {
    if (!fullscreen) {
      setBarRevealed(false);
      return;
    }
    const onPointer = (event: PointerEvent) => {
      const stageTop = stageRef.current?.getBoundingClientRect().top ?? 0;
      const barBottom = barRef.current?.getBoundingClientRect().bottom ?? 0;
      const next = event.clientY <= Math.max(stageTop + BAR_REVEAL_EDGE, barBottom);
      // A pointer on the page fires this on every move of a drag, and a state write per move is work the drawing does
      // not get. Same value, same state.
      setBarRevealed((current) => (current === next ? current : next));
    };
    window.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [fullscreen]);

  // Auto-hide the sidebar and replace it with the hamburger menu whenever a rendered preview is ready.
  // When leaving the canvas or when no page is rendered, sidebar restore is handled cleanly.
  //
  // `active` is in the condition rather than only in the dependency list, and that is the JSON view: the canvas stays
  // mounted there (its previews must survive the peek), so without this it would go on hiding the navigation over a
  // textarea — the state a user only ever saw *leave* when the editor was unmounted.
  useEffect(() => {
    const hasReady = active && Object.values(previews).some((p) => p.status === 'ready');
    setSidebarHidden(hasReady);
  }, [active, previews, setSidebarHidden]);

  //
  // Full screen ends with the drawing it was taken for: the mode's own way out is this canvas's `Escape`, and a hidden
  // canvas cannot answer it — so entering the JSON view from full screen used to leave the shell's navigation hidden
  // over a form with no key that brought it back.
  //
  useEffect(() => {
    if (!active && fullscreen) setFullscreen(false);
  }, [active, fullscreen, setFullscreen]);

  // Clean up auto-hidden sidebar state on unmount
  useEffect(() => () => setSidebarHidden(false), [setSidebarHidden]);

  const renderPage = useCallback(
    async (target: number) => {
      if (!document || inFlight.current.has(target)) return;
      inFlight.current.add(target);
      setPreviews((current) => ({
        ...current,
        [target]: { jobId: '', part: 0, status: 'rendering', error: null },
      }));
      setNotice(null);
      try {
        // One page per job: the preview the user is looking at is the only one that has to exist, and a single A4 page
        // at 96 dpi is ~200 kB, so this is a sub-second round trip rather than a document-scale export.
        const created = await createJob({
          tool: renderTool,
          files: [document.id],
          options: { format: 'png', dpi, colorMode: 'color', pages: [String(target)] },
          retainMinutes: 30,
        });

        let status = created.status;
        for (let attempt = 0; attempt < 60 && !isTerminal(status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          const fresh = await getJob(created.id);
          status = fresh.status;
          if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED') {
            throw new ApiError('PREVIEW_FAILED', fresh.error?.message ?? 'The preview job did not finish.', 200);
          }
        }
        if (!isTerminal(status)) {
          throw new ApiError('PREVIEW_TIMEOUT', 'The preview is taking longer than expected.', 200);
        }

        const result = await getJobResult(created.id);
        // The part's own `pages` says which page it is: `pdf-to-images` numbers its output densely over the rendered
        // set, so the index is not the page number and assuming it were would silently show the wrong page.
        const partIndex = result.parts.findIndex((part) => (part.pages ?? []).includes(target));
        if (partIndex < 0) {
          throw new ApiError('PREVIEW_EMPTY', `The renderer returned no image for page ${target}.`, 200);
        }
        setPreviews((current) => ({
          ...current,
          [target]: { jobId: created.id, part: partIndex, status: 'ready', error: null },
        }));
      } catch (cause) {
        setPreviews((current) => ({
          ...current,
          [target]: { jobId: '', part: 0, status: 'failed', error: errorText(cause) },
        }));
      } finally {
        inFlight.current.delete(target);
      }
    },
    [document, dpi, renderTool],
  );

  /**
   * Render every page of the document, in order, one job at a time.
   *
   * The unit stays one page = one job, because that is what the renderer offers and because a failed page must not take
   * the other nine with it. What the bulk pass buys is the *waiting*: a ten-page document is ten round trips the user
   * would otherwise make by hand, one page at a time, choosing each page before the next one could even be asked for.
   * Pages already rendered are skipped, so pressing it again after adding a page renders only that page, and `Stop` —
   * which is checked between jobs rather than inside one — leaves everything already rendered on screen.
   */
  const renderAll = useCallback(async () => {
    const targets = Array.from({ length: totalPages }, (_, index) => index + 1).filter(
      (target) => previews[target]?.status !== 'ready',
    );
    if (targets.length === 0) return;
    bulkStop.current = false;
    setBulk({ done: 0, total: targets.length });
    for (let at = 0; at < targets.length; at += 1) {
      if (bulkStop.current) break;
      await renderPage(targets[at]!);
      setBulk((current) => (current ? { ...current, done: at + 1 } : current));
    }
    setBulk(null);
  }, [previews, renderPage, totalPages]);

  //
  // Once the user has asked for one preview they have opted into the mechanism, so moving to another page renders it
  // rather than making them press the button again. The first one stays a click on purpose: it creates a job.
  //
  // It is also **the studio's own switch**. Before the first page is rendered the screen is a preparation panel — the
  // file, a page to choose, and the two ways to render it — and the toolbox, the drawing and the inspector arrive
  // together with the first rendered page, because that is the moment the numbers have something to be checked against.
  //
  const preferPreview = Object.values(previews).some((entry) => entry.status === 'ready');
  useEffect(() => {
    if (!preferPreview || !document) return;
    if (previews[page]) return;
    void renderPage(page);
  }, [preferPreview, previews, page, document, renderPage]);

  /**
   * The canvas is as wide as its column, so **`Fit` means fit**: measured rather than guessed, because the studio is a
   * grid whose middle cell is whatever the rail and the inspector leave (`styles/globals.css`, `.studio-body`). The
   * observer is what covers full screen as well as a resized window, and it does that by itself: the mode widens the
   * stage's own box, which is exactly the change a `ResizeObserver` exists to report.
   *
   * **The dependency is the stage existing, and that is the one non-obvious line here.** Before the first preview there
   * is no `placement-wrap` at all — the preparation panel is what is on screen — so an effect that ran once would find
   * `null`, attach nothing, and never look again: `fitScale` would stay at its initial `1`, the page would open at 100 %
   * in a column 18 % wider than it, and the `Fit` button would be a button that did nothing (measured on the served page
   * the moment the studio was introduced). Re-running when the studio opens is what attaches the observer to the node
   * that finally exists.
   */
  useEffect(() => {
    // Both halves of the same condition, and the second one is the trigger: there is nothing to measure until the studio
    // is what is on screen, and reading it here is what makes it a dependency the effect really uses.
    const node = wrapRef.current;
    if (!node || !preferPreview) return;
    const measure = () => setFitScale(node.clientWidth > 0 ? Math.min(1.5, node.clientWidth / 794) : 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [preferPreview]);

  // Deliberately `HTMLElement`: the same helper measures the surface, the marks (which are buttons) and the resize
  // handle (a span), and all it needs from any of them is their bounding rectangle.
  const pointerAt = useCallback((event: ReactPointerEvent<HTMLElement>): Point => {
    //
    // **The surface is the one element every pointer sample is measured against**, whatever element the handler lives
    // on. A mark's own `onPointerDown` has `event.currentTarget` = the mark and a handle's is the handle, so measuring
    // a drag's start against the child's rect put the start in mark-local pixels while every move stayed surface-local:
    // the first move re-anchored the mark by its own offset (measured: a mark at `x = 45.29` jumped 92 px on the first
    // 20 px move, defect 254). The surface is where capture is set, so it is also the only rect a drag can trust.
    //
    const rect = (surfaceRef.current ?? event.currentTarget).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const pointToPdf = useCallback(
    (point: Point): Point => {
      if (!geometry) return { x: 0, y: 0 };
      const perPoint = pixelsPerPoint(geometry);
      return { x: point.x / perPoint, y: geometry.page.heightPt - point.y / perPoint };
    },
    [geometry],
  );

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!geometry || event.button !== 0) return;
    const origin = pointerAt(event);

    // While a stroke is open every click is a point of it, which is the only gesture a freehand mark can have.
    if (drawing != null) {
      const at = pointToPdf({ x: origin.x, y: origin.y });
      updateItem(drawing, (item) => adapter.addStrokePoint(item, at));
      return;
    }

    //
    // **Select is the resting tool, and it places nothing.** With a kind always armed, every click on blank page
    // created a mark — so "look at what is there and move it" meant arming a tool and risking a stray element with
    // every click that missed. In `Select`, a click on the page clears the selection (and closes an open text field);
    // the marks themselves are still clicked, dragged and nudged exactly as before.
    //
    if (kind === SELECT_KIND) {
      setSelected(null);
      setEditing(null);
      setNotice(null);
      return;
    }

    // The gesture is opened **before** the drag begins, so the entry it takes holds the page without this mark on it.
    beginGesture('drag');
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = false;
    setDrag({ mode: 'create', kind, origin, current: origin });
    setSelected(null);
    setNotice(null);
  };

  const onBoxPointerDown = (index: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!geometry || event.button !== 0) return;
    event.stopPropagation();
    const item = items[index];
    const box = item ? adapter.box(item) : null;
    if (!box || !item) return;
    // Read *before* the selection moves: "click the selected mark again to type on it" is a click on a mark that was
    // already selected when the pointer went down, and the gesture's own first move selects it.
    const wasSelected = selected === index;
    dragged.current = false;
    setSelected(index);
    setNotice(null);
    if (adapter.strokeKinds.includes(item.kind)) return;
    beginGesture('drag');
    // The surface owns the pointer capture so a fast drag that leaves the box keeps moving it, which is what every
    // direct-manipulation surface does and what a captured box would break.
    surfaceRef.current?.setPointerCapture(event.pointerId);
    setDrag({ mode: 'move', index, start: pointerAt(event), startBox: box, wasSelected });
  };

  const onHandlePointerDown = (index: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!geometry) return;
    event.stopPropagation();
    const item = items[index];
    const box = item ? adapter.box(item) : null;
    if (!box) return;
    beginGesture('drag');
    surfaceRef.current?.setPointerCapture(event.pointerId);
    const rect = displayRectFromBox(box, geometry);
    setDrag({
      mode: 'resize',
      index,
      startRect: { left: rect.left, top: rect.top },
      start: pointerAt(event),
    });
  };

  const onSurfacePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !geometry) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    if (drag.mode === 'create') {
      setDrag({ ...drag, current: at });
      return;
    }

    if (drag.mode === 'move') {
      if (Math.abs(at.x - drag.start.x) + Math.abs(at.y - drag.start.y) > CLICK_SLOP_PX) dragged.current = true;
      const perPoint = pixelsPerPoint(geometry);
      const dx = (at.x - drag.start.x) / perPoint;
      // Display y grows down, PDF y grows up: a downward drag lowers the mark, so the sign is the second place the axis
      // flip has to be stated correctly.
      const dy = (at.y - drag.start.y) / perPoint;
      const next = clampBox({ ...drag.startBox, x: drag.startBox.x + dx, y: drag.startBox.y - dy }, geometry.page);
      updateItem(drag.index, (item) => adapter.move(item, next));
      return;
    }

    if (drag.mode === 'resize') {
      const rect = {
        left: drag.startRect.left,
        top: drag.startRect.top,
        width: Math.max(0, at.x - drag.startRect.left),
        height: Math.max(0, at.y - drag.startRect.top),
      };
      const box = clampBox(boxFromDisplay(rect, geometry), geometry.page);
      updateItem(drag.index, (item) => adapter.move(item, box));
    }
  };

  const onSurfacePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !geometry) return;
    if (drag.mode === 'create') {
      const at = pointerAt(event);
      const left = Math.min(drag.origin.x, at.x);
      const top = Math.min(drag.origin.y, at.y);
      const rect = {
        left,
        top,
        width: Math.abs(at.x - drag.origin.x),
        height: Math.abs(at.y - drag.origin.y),
      };
      const originPdf = pointToPdf(drag.origin);
      const size = adapter.defaultSize(drag.kind);
      // A point kind is placed where the pointer was; a box kind keeps what was drawn, or falls back to the default box
      // when the gesture was a click. Both are clamped, because a mark hanging off the page is a job whose output does
      // not contain the change the user watched themselves make.
      const box =
        adapter.geometry(drag.kind) === 'point'
          ? clampBox(centredBox(size, originPdf), geometry.page)
          : clampBox(normaliseDraggedBox(size, boxFromDisplay(rect, geometry), originPdf), geometry.page);
      onChange([...items, adapter.create(drag.kind, page, box)]);
      setSelected(items.length);
      if (adapter.strokeKinds.includes(drag.kind)) {
        // The stroke is one entry for the whole mark, not one per point: its points arrive as separate clicks, so the
        // gesture stays open until the stroke is finished (`endGesture`, from the rail's own button).
        gesture.current = 'stroke';
        setDrawing(items.length);
        setNotice('Freehand: keep clicking to add points, then press Finish stroke.');
      } else {
        endGesture();
        setNotice(null);
      }
    }

    //
    // **A click on the mark that is already selected opens its words.** The gesture has to stay a drag as well — a mark is
    // moved by dragging it, and it is selected by the click that starts that drag — so the click is the drag that never
    // travelled (`CLICK_SLOP_PX`), and that is how every direct-manipulation surface separates the two. Only the shapes
    // with something to type are offered it (`adapter.textOf`), which is why a second click on a checkbox is still just a
    // click.
    //
    if (drag.mode === 'move' && drag.wasSelected && !dragged.current) beginEditing(drag.index);
    endGesture();
    setDrag(null);
  };

  /**
   * Open the page's own text field on a mark: its words move out of the row's `Text` field and onto the page, in the
   * element's own font size, colour and position.
   *
   * The draft starts as what the mark already says, so opening the field and pressing Escape is a no-op rather than a
   * deletion — which is the difference between an editor and a demo.
   */
  function beginEditing(index: number) {
    const item = items[index];
    const text = item ? (adapter.textOf?.(item) ?? null) : null;
    if (!text || !adapter.withText) return;
    skipCommit.current = false;
    setSelected(index);
    setDraft(text.text);
    setEditing(index);
  }

  /** Write the draft into the element — the one place the page's words are committed. */
  function commitEditing() {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    const index = editing;
    const withText = adapter.withText;
    setEditing(null);
    if (index == null || !withText || items[index] == null) return;
    updateItem(index, (current) => withText(current, draft));
  }

  /** Leave the element exactly as it was. A field that cannot be abandoned is a field nobody types in. */
  function cancelEditing() {
    skipCommit.current = true;
    setEditing(null);
    setDraft('');
  }

  function updateItem(index: number, change: (item: PlacementItem) => PlacementItem) {
    // Every change to a mark comes through here — a drag's move, a row's field, the committed text — which is why this
    // is where the history is told about one. It decides: inside a gesture the entry exists already, and a burst of
    // field edits is one entry (see `recordEdit`).
    recordEdit();
    onChange(items.map((item, at) => (at === index ? change(item) : item)));
  }

  /**
   * Arrow keys move a mark by **points**, not pixels.
   *
   * The numbers in the list are what the engine reads, so the keyboard nudges those: 1 pt per press for fine placement,
   * 10 with Shift. A drag cannot promise that precision and does not have to — this is the path that makes the canvas
   * usable without a pointer, and it is exact by construction.
   */
  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!geometry) return;
    const step = event.shiftKey ? 10 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    setSelected(index);
    updateItem(index, (item) => {
      const box = adapter.box(item);
      if (!box) return item;
      return adapter.move(item, clampBox({ ...box, x: box.x + delta[0], y: box.y + delta[1] }, geometry.page));
    });
  };

  const addAtPageCentre = () => {
    const pageBox = geometry?.page ?? { widthPt: 595, heightPt: 842 };
    const size = adapter.defaultSize(kind);
    const box = clampBox(centredBox(size, { x: pageBox.widthPt / 2, y: pageBox.heightPt / 2 }), pageBox);
    recordOnce();
    onChange([...items, adapter.create(kind, page, box)]);
    setSelected(items.length);
  };

  const pageItems = items.map((item, index) => ({ item, index })).filter((entry) => entry.item.page === page);
  const displayed = geometry && natural ? displayScale(natural, geometry) : null;
  const activeLabel = toolbar.find((candidate) => candidate.id === kind)?.label ?? kind;
  // The rendered scale as a percentage — the page image's own pixels on this screen (`fitScale × zoom`), which is the only
  // magnification figure that means anything to a user: fit is this column's width and nobody knows what that is in
  // percent, while "62 %" is a fact about what is on screen.
  const zoomPercent = geometry ? Math.round(geometry.scale * 100) : null;

  //
  // ── Before the first preview: prepare, do not edit ───────────────────────
  //
  // This is the screen's *ordering*, and it is the flow the whole editor is built around: choose the file, look at it,
  // pick the page (or render them all), and only then does the toolbox arrive. A rail of tools over an empty box asked
  // the user to choose how to write a caption before they had seen the page it goes on, and the panel beside it listed
  // elements whose positions ('x: 240, y: 612') mean nothing until there is a picture to read them against. Nothing is
  // reachable only here — a placement written as JSON is still one click away under the canvas.
  //
  //
  // Without a document there is nothing to draw and nothing to prepare: one sentence and the way out (`Edit as JSON`,
  // under the canvas) rather than a toolbox over an empty box. The tool page renders its own drop target here, so this is
  // the state a caller that draws the canvas on its own gets.
  //
  if (!document) {
    return (
      <div className="placement-empty small muted">
        {`Add a document and the canvas opens on it — every ${adapter.noun} is still editable as JSON below in the meantime.`}
      </div>
    );
  }

  if (!preferPreview) {
    return (
      //
      // A `<section>` rather than a `<div>`: the frame around it is the page's, so with `framed` there is no `Field` label
      // above it — and this is the area the reader is about to place marks in, so it is a named region of the document
      // rather than an anonymous box. (`role="group"` would say the same thing and the linter answers, correctly, that a
      // group is a `fieldset`; a labelled section is the element for "a part of this page with a name".)
      //
      <section className="studio-prepare" aria-label={field.label}>
        <div className="studio-prepare-file">
          <span className="card-head-icon" aria-hidden="true">
            <IconFileText size={15} />
          </span>
          <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <span className="small strong truncate">{document.name}</span>
            <span className="tiny faint">
              {document.pages} page{document.pages === 1 ? '' : 's'} · {formatBytes(document.sizeBytes)} · every page
              stays in this installation
            </span>
          </span>
        </div>
        {preview?.status === 'failed' ? (
          <Alert tone="danger" title="The page could not be rendered">
            <span className="small">{preview.error}</span>
          </Alert>
        ) : null}
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <SelectInput
            aria-label="Page"
            value={String(page)}
            options={Array.from({ length: totalPages }, (_, index) => ({
              value: String(index + 1),
              label: `Page ${index + 1}`,
            }))}
            onChange={(event) => setPage(Number(event.currentTarget.value))}
          />
          <Button variant="primary" loading={preview?.status === 'rendering'} onClick={() => void renderPage(page)}>
            {`Render page ${page}`}
          </Button>
          <Button
            variant="secondary"
            loading={bulk != null}
            disabled={totalPages === 1}
            title={`Render all ${totalPages} page${totalPages === 1 ? '' : 's'} now, so moving between pages is instant`}
            onClick={() => void renderAll()}
          >
            {`Render all ${totalPages} pages`}
          </Button>
        </div>{' '}
        {bulk ? (
          <BulkProgress
            bulk={bulk}
            onStop={() => {
              bulkStop.current = true;
            }}
          />
        ) : null}
        <p className="small muted" style={{ margin: 0 }}>
          {preview?.status === 'rendering'
            ? `Rendering page ${page}…`
            : `The toolbox and the ${adapter.noun} panel open once a page has been rendered — the drawing is the coordinate system every number in them is written against.`}
        </p>
        <p className="tiny faint" style={{ margin: 0 }}>
          A preview is a real job of its own: one <code>pdf-to-images</code> render per page at {dpi} dpi, kept for 30
          minutes and visible in your history. The document is never modified by it.
        </p>
      </section>
    );
  }

  return (
    //
    // Full screen turns **this** element into the viewport (`styles/globals.css`, `.placement-fullscreen`): the toolbox,
    // the zoom and the page image are the canvas, so they travel together, and the inspector stays mounted and hidden
    // because it is the same value as the drawing rather than part of it. A class rather than a portal, and that is the
    // whole reason: moving this subtree into a portal would unmount the rendered page image and throw the preview job
    // away on the way back in.
    //
    <section
      ref={stageRef}
      className={
        fullscreen
          ? `placement-studio placement-fullscreen${barRevealed ? ' placement-bar-revealed' : ''}`
          : 'placement-studio'
      }
      // `hidden` rather than a conditional render (`PlacementField`), and the rule in `styles/globals.css` is what makes
      // it stick: the class carries `display: flex`, which would win over the attribute's own `display: none`.
      hidden={!active}
      aria-label={field.label}
    >
      {/*
        The bar: one row that says what is open, where in it, and how big — the three questions a page editor is asked
        in the middle of a gesture. The document's name is truncated rather than wrapped (`truncate`) so the controls keep
        their place however long the file's name is.
      */}
      <div ref={barRef} className="studio-bar">
        <span className="studio-bar-doc" title={document.name}>
          <IconFileText size={15} />
          <span className="small strong truncate">{document.name}</span>
        </span>
        <span className="studio-page-chip">{`page ${page} of ${totalPages}`}</span>

        {/*
          The run's facts, in the bar **while the mode is the page**. Full screen hides the inspector and with it the
          foot these four facts otherwise live in, so the bar — the one part of the studio the mode keeps, and the one
          that slides back in when the pointer reaches the stage's top edge — is where they have to be for a reader to
          reach them at all. `barFacts` rather than `facts` because the panel opens *downward* here: the bar rides the
          stage's top edge, and the stage clips its own overflow, so a panel above the trigger would be cut off
          (`PlacementFieldProps.barFacts`).
        */}
        {fullscreen ? barFacts : null}

        <div className="studio-bar-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <IconArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            <IconArrowRight size={15} />
          </button>
          <span className="studio-divider" aria-hidden="true" />
          {/*
            The history's two controls, beside the page's own `‹ ›` and behind a divider of their own — the same
            reasoning as the glyphs: an editor whose undo looks like navigation is an editor whose undo gets pressed by
            mistake. Disabled rather than hidden when a stack is empty, so the pair never moves.
          */}
          <button
            type="button"
            className="icon-btn"
            aria-label="Undo"
            title="Undo the last change (Ctrl/⌘ + Z)"
            disabled={history.past.length === 0}
            onClick={undo}
          >
            <IconUndo size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Redo"
            title="Redo (Ctrl/⌘ + Shift + Z)"
            disabled={history.future.length === 0}
            onClick={redo}
          >
            <IconRedo size={15} />
          </button>
          <span className="studio-divider" aria-hidden="true" />
          <div className="placement-zoom">
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => stepZoom(-1)}
            >
              <IconMinus size={15} />
            </button>
            <span className="placement-zoom-label">{zoomPercent == null ? 'Fit' : `${zoomPercent} %`}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => stepZoom(1)}
            >
              <IconPlus size={15} />
            </button>
            <Button
              size="sm"
              variant={zoom === 1 ? 'secondary' : 'ghost'}
              aria-pressed={zoom === 1}
              title="Fit the page to the canvas — the size it opens at"
              onClick={() => setZoom(1)}
            >
              Fit
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            title="Render this page again — a new preview job"
            onClick={() => void renderPage(page)}
          >
            <IconRefresh size={15} />
            Render again
          </Button>
          <Button
            size="sm"
            variant={fullscreen ? 'secondary' : 'ghost'}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Leave full screen (Esc)' : 'Edit the page with the navigation out of the way'}
            onClick={() => setFullscreen(!fullscreen)}
          >
            {fullscreen ? <IconCollapse size={15} /> : <IconExpand size={15} />}
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </Button>
        </div>
      </div>

      {/*
        The bulk render's own reading, and it has to be **here** rather than only under the button that started it: the
        first page landing opens the studio, which unmounts the preparation panel — so without this the last nine pages of
        a ten-page "Render all" would be rendered with nothing on screen saying so.
      */}
      {bulk ? (
        <div className="studio-bulk-row">
          <BulkProgress
            bulk={bulk}
            onStop={() => {
              bulkStop.current = true;
            }}
          />
        </div>
      ) : null}

      <div className="studio-body">
        <PlacementToolbox
          tools={toolbar}
          active={kind}
          onPick={setKind}
          // A freehand stroke is built by clicking the page, so the tools that would change what a click means are
          // parked until it is finished — with the one control that ends it beside them.
          footer={
            drawing != null ? (
              <button
                type="button"
                className="studio-rail-btn studio-rail-done"
                aria-label="Finish stroke"
                onClick={() => {
                  // The stroke closes here, and so does the history entry that has been held open for it.
                  endGesture();
                  setDrawing(null);
                  setNotice(null);
                }}
              >
                <IconCheck size={19} />
                <span className="studio-tip" aria-hidden="true">
                  <span className="studio-tip-name">Finish stroke</span>
                </span>
              </button>
            ) : null
          }
        />

        {/*
          The stage: the rendered page, and everything the toolbox writes onto it.

          It is the middle column and the one that takes the leftover width (`minmax(0, 1fr)`), because a page is the
          thing being looked at and the panels around it have fixed jobs. `placement-wrap` is still the measuring node
          (`fitScale` is this column's own width) and still a **viewport** — a page taller than the column scrolls inside
          it rather than pushing the toolbar off the top of the screen.
        */}
        <div ref={wrapRef} className="placement-wrap">
          {preview?.status === 'failed' ? (
            <Alert tone="danger" title="The page could not be rendered">
              <span className="small">{preview.error}</span>
            </Alert>
          ) : null}

          {preview?.status === 'ready' ? (
            <div
              ref={surfaceRef}
              className="placement-surface"
              style={{ width: displayed?.width, height: displayed?.height }}
              onPointerDown={onSurfacePointerDown}
              onPointerMove={onSurfacePointerMove}
              onPointerUp={onSurfacePointerUp}
            >
              <img
                className="placement-page"
                src={`/api/v1/jobs/${preview.jobId}/download?part=${preview.part}`}
                alt={`Page ${page}`}
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setNatural({ width: image.naturalWidth, height: image.naturalHeight });
                }}
              />

              {geometry
                ? pageItems.map(({ item, index }) => {
                    const box = adapter.box(item);
                    if (!box) return null;
                    const rect = displayRectFromBox(box, geometry);
                    const active = selected === index;
                    const resizable = adapter.geometry(item.kind) === 'box';
                    // A real `<button>`, not a div with a role: each mark is a focusable object the keyboard can reach, and
                    // the arrow keys then nudge *it* rather than a canvas-wide handler that has to know which mark is meant.
                    // Fixing inside `onPointerDown` is impossible from the keyboard, which is exactly why the mark is the
                    // semantic element here.
                    return (
                      <button
                        type="button"
                        key={`${index}-${item.kind}`}
                        className={`placement-mark ${active ? 'is-selected' : ''} placement-mark-${item.kind}`}
                        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                        onPointerDown={onBoxPointerDown(index)}
                        onFocus={() => setSelected(index)}
                        onKeyDown={(event) => nudge(event, index)}
                        aria-label={`${adapter.noun} ${index + 1}: ${adapter.summary(item)}`}
                        aria-pressed={active}
                      >
                        {adapter.overlay(item, geometry)}
                        {active && resizable ? (
                          <span
                            className="placement-handle"
                            onPointerDown={onHandlePointerDown(index)}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className="placement-index">{index + 1}</span>
                      </button>
                    );
                  })
                : null}

              {/*
                The page's own text field, laid over the mark it is replacing.

                It is inside the surface, and it is the last child of it, for two reasons: the box's position is the
                *drawing's* position (`displayRectFromBox` of the element's own box, at the current zoom), and it has to sit
                above the mark it covers — so the page is the field's coordinate system rather than a card's.
              */}
              {editing != null && geometry
                ? (() => {
                    const item = items[editing];
                    const text = item ? (adapter.textOf?.(item) ?? null) : null;
                    const box = item ? adapter.box(item) : null;
                    if (!item || !text || !box) return null;
                    const perPoint = pixelsPerPoint(geometry);
                    const rect = displayRectFromBox(box, geometry);
                    return (
                      <InlineTextEditor
                        // One mount per mark, so the field is focused and selected once and not on every keystroke.
                        key={editing}
                        label={`Text of ${adapter.noun} ${editing + 1}`}
                        value={draft}
                        fontSize={Math.max(6, text.size * perPoint)}
                        //
                        // The width follows the draft, which is the same string the mark's own width is measured from
                        // (`textWidthPoints`) and in the same face (`text.font`): the field the user is typing into grows
                        // into the box their words will have when they stop.
                        //
                        width={Math.max(textWidthPoints(draft, text.size, text.font) * perPoint + 14, 60)}
                        left={rect.left}
                        top={rect.top}
                        height={rect.height}
                        color={text.color}
                        onChange={setDraft}
                        onCommit={commitEditing}
                        onCancel={cancelEditing}
                      />
                    );
                  })()
                : null}

              {drag?.mode === 'create'
                ? (() => {
                    const left = Math.min(drag.origin.x, drag.current.x);
                    const top = Math.min(drag.origin.y, drag.current.y);
                    return (
                      <div
                        className="placement-ghost"
                        style={{
                          left,
                          top,
                          width: Math.abs(drag.current.x - drag.origin.x),
                          height: Math.abs(drag.current.y - drag.origin.y),
                        }}
                      />
                    );
                  })()
                : null}
            </div>
          ) : (
            <div className="placement-empty small muted">
              {preview?.status === 'failed'
                ? `Page ${page} could not be rendered — press “Render again” in the bar above.`
                : `Rendering page ${page}…`}
            </div>
          )}
        </div>

        {/*
          The inspector: the numbers, the tool's own settings and the hint, in one column that does not move.

          The drawing and the list are the same value — every number here is a mark's own position — which is why they are
          side by side rather than one under the other: dragging a mark and reading its `x` have to be possible without
          scrolling. It is also where the tool page's other controls arrive (`children`), because they are settings *of
          the marks* rather than of the file: a flatten toggle two screens below the elements it flattens is a control
          nobody finds.
        */}
        <aside className="studio-inspector" aria-label={`${adapter.noun} panel`}>
          <div className="studio-inspector-head">
            <span className="label">On page {page}</span>
            <span className="tiny faint">
              {pageItems.length} of {items.length}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 6 }}>
            <Button size="sm" variant="primary" disabled={kind === SELECT_KIND} onClick={addAtPageCentre}>
              Add {activeLabel}
            </Button>
            {items.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  recordOnce();
                  onChange([]);
                  setSelected(null);
                }}
              >
                Clear all
              </Button>
            ) : null}
          </div>

          {notice ? (
            <Alert tone="info" title="Freehand stroke open">
              <span className="small">{notice}</span>
            </Alert>
          ) : null}

          {items.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Nothing placed yet.{' '}
              {kind === SELECT_KIND
                ? 'Pick a tool from the rail on the left, then click the page — or press the add button above.'
                : `Click the page to place ${activeLabel.toLowerCase()}, or press the add button above to put one in the middle.`}
            </p>
          ) : null}

          <div className="placement-list stack-sm">
            {items.map((item, index) => (
              <PlacementRow
                key={`${index}-${item.kind}`}
                adapter={adapter}
                item={item}
                index={index}
                selected={selected === index}
                onSelect={() => {
                  setSelected(index);
                  setPage(item.page);
                }}
                onChange={(next) => updateItem(index, () => next)}
                onRemove={() => removeAt(index)}
              />
            ))}
          </div>

          {children ? <div className="studio-inspector-options">{children}</div> : null}

          {/*
            The foot: the `ⓘ` the tool page handed in and the canvas's own sentence about the keyboard, in one row.

            They belong together because they are the two things a reader comes back to mid-session — "what will this
            run cost me" and "how do I move this mark" — and because the sentence ends on a *fact* ("30-minute
            retention") that the panel beside it states as policy, which is the reading a bare sentence cannot give.
            The facts are a node rather than a prop of numbers: the canvas knows nothing about plans or pools
            (`PlacementFieldProps.facts`).

            In full screen the whole inspector is hidden (`styles/globals.css`) *and* the node is dropped here rather
            than left in a hidden subtree: the facts have exactly one home in each mode, so this is the bar's own copy
            in the other one — one `ⓘ` mounted at a time, never two.
          */}
          <div className="placement-hint">
            {fullscreen ? null : facts}
            {/*
              The paragraph is last so the `ⓘ` reads as the row's label rather than as a bullet between two sentences,
              and it keeps its words unchanged: this is the same hint it has always been, now with the run's facts
              reachable from the row it sits in.
            */}
            <p className="tiny faint" style={{ margin: 0 }}>
              drag a mark to move it · arrow keys nudge by a point · ⌫/Delete removes the selected one · ⌘/Ctrl + C/X/V
              copy, cut and paste it, and + D duplicates it · Esc lets go of the selection · ⌘/Ctrl + wheel zooms ·
              previews are real jobs, one page each, 30-minute retention
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

/**
 * Whether a keystroke is being *typed* into something rather than aimed at the canvas.
 *
 * The one question the removal shortcut has to ask before it acts: the canvas's own fields write per keystroke, and a
 * `Backspace` in a caption means a letter, never the element the caption is on. `contentEditable` is checked alongside
 * the three tags because a rich field is built out of it rather than out of `<input>` — the JSON editor in this feature
 * is a textarea today and the question is the same whichever it becomes.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** A page image's own pixels × the canvas scale: the size the surface is drawn at. */
function displayScale(natural: { width: number; height: number }, geometry: DisplayGeometry) {
  const perPoint = pixelsPerPoint(geometry);
  return { width: natural.width * geometry.scale, height: natural.height * geometry.scale, perPoint };
}

// ─── The mark list ───────────────────────────────────────────────────────────

/**
 * One row per mark: the shape's own fields, plus the four things every shape has.
 *
 * The row is also the canvas's accessible path — it names each mark, lets any of its numbers be typed, and removes it —
 * which is why it exists for every shape rather than only for the ones with extra fields.
 */
function PlacementRow({
  adapter,
  item,
  index,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  adapter: PlacementAdapter;
  item: PlacementItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (next: PlacementItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`placement-row ${selected ? 'is-selected' : ''}`}>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <button type="button" className="placement-row-head" onClick={onSelect}>
          <Badge tone="neutral">{item.kind}</Badge>
          <span className="small placement-row-title">{adapter.summary(item)}</span>
        </button>
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${adapter.noun} ${index + 1}`}>
          Remove
        </Button>
      </div>

      {adapter.fields(item, onChange, index)}
    </div>
  );
}

/**
 * The page's own text field: a real `<input>` laid over the words it replaces.
 *
 * Three things make it not just an input in a box:
 *
 *  - **It is the element's own type.** The font size is the element's, scaled by the canvas zoom; the colour is the
 *    element's; the face is the element's (`textOf`'s own `font`), so what is typed is measured in the metrics of the face
 *    the mark is drawn in — the browser substitute is what the glyphs are *shown* in (`TEXT_FONT_FAMILY`), while the width
 *    comes from the engine's own advances (`textWidthPoints`).
 *  - **It sits on the baseline**, which is where a text element is anchored: the field is pushed down by the font's own
 *    half-leading plus descent, measured at run time (`textBaselineDropEm`) rather than written down as an approximation
 *    that is right for one platform's Helvetica substitute and wrong for the next one's.
 *  - **Enter commits and Escape abandons it.** A field an edit cannot be taken back out of is a field nobody types a
 *    sentence into; the draft lives in the canvas (`editing`/`draft`) precisely so Escape is possible.
 *
 * It is focused and selected **once, on mount**, and not by an effect that runs on every render: re-selecting the text as
 * the user types would replace each keystroke with the whole draft.
 */
function InlineTextEditor({
  label,
  value,
  left,
  top,
  width,
  height,
  fontSize,
  color,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string;
  value: string;
  /** The mark's box in display pixels — the surface is the field's coordinate system. */
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  return (
    <input
      ref={ref}
      className="placement-text-editor"
      aria-label={label}
      value={value}
      spellCheck={false}
      autoComplete="off"
      // The surface reads a pointer on itself as the start of a drag, and this field is a child of the surface: without
      // this, clicking into the text to place the caret would also be drawing a new mark underneath it.
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={onCommit}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit();
          return;
        }
        if (event.key === 'Escape') {
          // Stopped as well as prevented: Escape is also how full screen is left, and abandoning an edit should not also
          // close the stage the edit is happening in.
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      style={{
        left,
        // Down by the font's own drop, so the field's baseline lands where the mark's does.
        top: top + textBaselineDropEm() * fontSize,
        width,
        height,
        fontSize,
        fontFamily: TEXT_FONT_FAMILY,
        lineHeight: TEXT_LINE_HEIGHT_EM,
        color,
      }}
    />
  );
}

/**
 * The bulk render, as one line: how far it has got, what is left, and the way to stop it.
 *
 * Shared by the preparation panel and the studio's own bar — the same job seen from the two screens it can be started
 * from and then watched on, which is why it is a component rather than two copies that would drift apart.
 */
function BulkProgress({ bulk, onStop }: { bulk: { done: number; total: number }; onStop: () => void }) {
  return (
    <div className="studio-bulk">
      <span className="small">
        {bulk.done >= bulk.total
          ? `Rendered ${bulk.total} page${bulk.total === 1 ? '' : 's'}.`
          : `Rendering preview ${bulk.done + 1} of ${bulk.total}…`}
      </span>
      <span className="studio-bulk-track" aria-hidden="true">
        <span className="studio-bulk-fill" style={{ width: `${Math.round((bulk.done / bulk.total) * 100)}%` }} />
      </span>
      <Button size="sm" variant="ghost" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

function isTerminal(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED';
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
