import type { UploadedFile } from '@pdftools/contracts/api';
import type { CatalogEntry } from '@pdftools/contracts/tools';
import { useMemo, useState } from 'react';
import { IconRotate, IconUpload } from '../../components/icons';
import { Alert, Button, Card } from '../../components/ui';
import { PageLightbox, PagePreview } from '../preview';
import { OptionsPanel } from '../tool-shell/options-panel';
import { type BoardRow, DocumentRow, Dropzone } from '../uploader';
import {
  TURNS,
  type Turn,
  canToggleTurn,
  clearedRotation,
  cycleTurn,
  describeRotate,
  describeTurn,
  distinctTurns,
  rotatePatch,
  rotatedPages,
  selectionFromOptions,
  setTurns,
  toggleTurn,
  turnBadge,
  turnsFromOptions,
  turnsReading,
} from './model';

/**
 * `rotate` as a document you turn (`docs/03-ORGANIZE-ROTATE-CROP.md` §2.2, `docs/0-UI-DESIGN.md` §3.3).
 *
 * Three options describe one fact — which way each page comes out — and the form could only ever show two of them: a
 * dropdown for `angle`, a range box for `pages`, and for `perPage`, which is the option that says each page's own
 * rotation, a **JSON box**. So the one tool whose whole product is an orientation was configured by typing
 * `{ "1": 90, "4": 270 }` at a document it had already drawn, and the arithmetic that makes the tool's behaviour
 * surprising — a rotation is additive, so a page already at 90° that is turned 90° reads 180° (§2.2) — appeared
 * nowhere on the screen.
 *
 * Now the pages are the form:
 *
 *  - **Every tile is drawn turned by that page's own angle**, which is the only preview that can be trusted for this
 *    tool: the worker writes `/Rotate` and the renderer applies it, so a page drawn turned is a page that will come out
 *    turned — and a page drawn upright is one the request does not touch.
 *  - **`⟳` and `⟲` on the tile** turn that page a quarter turn in either direction, in the three angles the API has.
 *    The third click returns to 90: a fourth quarter turn is the page as it was, which this tool cannot ask for, so the
 *    cycle closes instead of pretending to be "upright" (`cycleTurn` in `./model.ts`).
 *  - **`↻ 90°` / `180°` / `↺ 270°`** set every page of the selection to one angle — the dropdown's three choices, as
 *    buttons, spelled the way the tool's own choices are (`90° counter-clockwise`, never a bare `270`).
 *  - **The page number is that page's switch.** A click takes the page out of the turn — *left as it is*, which is the
 *    arithmetic's own `0` — and a second click gives it the document's prevailing angle back (`toggleTurn`). This is
 *    the one control that says "turn everything except page 3" in one click, which is the shape of most real requests
 *    (a cover page, a scan that is already upright) and the shape a form cannot express without arithmetic.
 *  - **A page that turns carries an `as is` button as well**, because the switch above is one only a reader who has been
 *    told about it can find: a page number on a plate looks like a label. It appears exactly when there is a turn to
 *    take back and is disabled on the document's last turning page, where at least one page has to turn.
 *  - **The tile's caption is the angle, on a line of its own** under the controls that change it — a caption for the
 *    state the row above it just changed, which is what it always was.
 *  - **`Reset all` puts every page back to *as is*** — the state a document arrives in — rather than to a quarter turn.
 *    The tool cannot *send* "no rotation" (`rotatePatch` refuses it, because an empty request is the schema's default
 *    and would turn every page a quarter), but the board can *say* it, and a reset that rotates the whole document is a
 *    reset nobody asked for (`clearedRotation` in `./model.ts`).
 *
 * **A document that has just arrived turns nothing**, and that is the state this board is built around rather than an
 * edge case. The option's schema default is 90°, so a screen that drew the default drew a quarter turn of every page
 * before the user had asked for anything — the one rotation on this screen nobody chose. So the empty option object is
 * drawn as it is: every page as it came in, a sentence saying nothing turns yet and which two controls turn it, and a
 * Run button that waits (`routes/tools.$toolId.tsx`). The first move is the user's, and the board says so.
 *
 * The three toolbar buttons and the tile switches write the *same three options*, and they always write all of them: the
 * switch on a tile changes the arrangement, and the arrangement is what `rotatePatch` serialises — so the panel's
 * `pages` rows are not a second control that can disagree with the drawing, they are the same value in its written form
 * (turn page 3 off and the rows read `1-2` and `4-6`, because a set of pages is written as its runs). A uniform angle
 * over the pages that turn is `angle` + `pages`; anything mixed is `perPage`, which is the option `perPage` was always
 * meant for and which no longer needs a JSON box.
 *
 * **And in that mixed state the rows become a reading rather than a control.** A map of page → angle is not a selection,
 * so the boxes have no value to hold — and writing one beside the map was refused by the worker (`PAGES_IGNORED`), so
 * there is nothing a keystroke there could mean. Rather than empty itself mid-session under a sentence about the wrong
 * document, the control keeps its place and lists the arrangement: one row per run of pages that turn one way, the run
 * spelled the grammar's way and the angle in the tiles' own words (`turnsReading`), with a sentence saying what the list
 * is and that one rotation button for every page brings the boxes back. The label, the place and the vocabulary stay;
 * what goes is the pretence that this field can be typed into while the request is a map.
 */

export function PageRotatePreview({
  tool,
  rows,
  values,
  title,
  accept,
  acceptLabel,
  maxFileMb,
  dropHint,
  multiple,
  disabled,
  locked,
  rejections,
  files,
  order,
  onFiles,
  onRemove,
  onRetry,
  onOptionChange,
  onTurns,
}: {
  tool: CatalogEntry;
  rows: BoardRow[];
  values: Record<string, unknown>;
  title: string;
  accept: string;
  acceptLabel: string;
  maxFileMb: number;
  dropHint: string;
  multiple: boolean;
  disabled?: boolean;
  locked?: boolean;
  rejections: string[];
  files: UploadedFile[];
  order: string[];
  onFiles: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onOptionChange: (key: string, value: unknown) => void;
  /** The turns the board means, as the request's own keys, or `null` when nothing this tool can write describes them. */
  onTurns: (patch: Record<string, unknown>) => void;
}) {
  const [openPage, setOpenPage] = useState<number | null>(null);
  const row = rows[0] ?? null;
  const total = row?.pages ?? null;
  const turns = useMemo(() => turnsFromOptions(values, total), [values, total]);
  const selection = useMemo(() => selectionFromOptions(values, total), [values, total]);
  const summary = useMemo(() => describeRotate(turns), [turns]);
  //
  // **The rows read the arrangement while the map is live** — the moment more than one angle is in play, which is exactly
  // the branch `rotatePatch` writes `perPage` in. The panel's `pages` field is cleared at that point (the two forms
  // cannot coexist), and an empty set of boxes under a label saying "pages that turn" is a control that has disappeared
  // mid-session: the rows stay and list the runs instead, in the same words as the tiles (`turnsReading`). One angle over
  // the whole document — or over the pages the boxes name — is a selection again, and the boxes come back by themselves.
  //
  const reading = useMemo(() => (distinctTurns(turns).length > 1 ? turnsReading(turns) : null), [turns]);

  const rejectionsAlert =
    rejections.length > 0 ? (
      <Alert tone="warning" title="That file was not added">
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {rejections.map((message) => (
            <li key={message} className="small">
              {message}
            </li>
          ))}
        </ul>
      </Alert>
    ) : null;

  const head = (heading: string) => (
    <div className="card-head">
      <span className="card-head-icon" aria-hidden="true">
        <IconUpload size={15} />
      </span>
      <span className="label">{heading}</span>
      <span className="tiny faint">
        {acceptLabel} · {maxFileMb} MB
      </span>
    </div>
  );

  /**
   * One write, always through the model: the board never sets an option key by hand.
   *
   * No selection argument, because the patch is derived from the arrangement alone — the request describes the document
   * on screen, and the panel's `pages` box is that same value in its written form rather than a separate target.
   */
  const commit = (next: readonly Turn[]) => {
    const patch = rotatePatch(next);
    if (patch) onTurns(patch);
  };

  if (!row) {
    return (
      <div className="tool-single">
        <Card className="card-pad upload-card" data-empty="true">
          <div className="stack">
            {head(`Add a document to ${title}`)}
            <Dropzone onFiles={onFiles} accept={accept} multiple={multiple} disabled={disabled} hint={dropHint} />
            {rejectionsAlert}
          </div>
        </Card>
      </div>
    );
  }

  const angleField = tool.optionsUi.find((field) => field.control === 'page-turn');
  const target = selection === null ? 'every page' : `page${selection.length === 1 ? '' : 's'} ${selection.join(', ')}`;
  const worked = rotatedPages(turns).length;

  return (
    //
    // **Stacked, not split** (`styles/globals.css`, `.tool-stacked`). The board is a row of tiles — six pages of a six
    // page document are one row of it — and a row cannot be measured against two thirds of a column while the options
    // sit beside it in the remaining third: the pages wrap, and the one question this screen asks (which way does *this*
    // page come out) stops being answerable at a glance. Stacked, the rotation gets the whole width and the document is
    // one band above it.
    //
    <div className="tool-split tool-split-board tool-stacked">
      <Card className="card-pad upload-card" data-empty="false">
        <div className="stack">
          {head('Your document')}
          <DocumentRow row={row} onRemove={onRemove} onRetry={onRetry} onPreview={() => setOpenPage(1)} />
          {rejectionsAlert}
        </div>
      </Card>

      <Card className="card-pad rotate-card anim-pop">
        <div className="stack">
          <div className="card-head">
            <span className="card-head-icon" aria-hidden="true">
              <IconRotate size={15} />
            </span>
            <span className="label">{angleField?.label ?? 'Rotation'}</span>
            {/*
             * How many pages turn, out of how many there are. It used to read `6 pages · 6 turns`, which counted the
             * same number twice and said nothing a person could use; what the head is for is the *shape* of the request
             * in one glance, and the sentence at the bottom already says what it will be.
             */}
            <span className="tiny faint">
              {turns.length} page{turns.length === 1 ? '' : 's'} ·{' '}
              {worked === turns.length ? 'every page turns' : `${worked} of ${turns.length} turn`}
            </span>
          </div>

          {/*
           * The set of pages that turn, first, because it is what the buttons below act on: the catalogue's own `pages`
           * field, read here and written back in the payload when the rotation is uniform over it — and the same value
           * the tile switches write, which is why a page switched off appears in this box as an omission.
           */}
          <div className="rotate-target">
            <OptionsPanel
              tool={tool}
              values={values}
              onChange={onOptionChange}
              files={files}
              order={order}
              renderFileOrder={false}
              renderPageTurn={false}
              pageRowsReading={reading}
            />
            {/*
             * What the buttons act on, in words. The set can be typed in the field above or built by clicking page
             * numbers, and a page the buttons are *not* going to reach is invisible in the box once the arrangement is
             * a map — so the sentence is what makes the target readable from the drawing either way. The way back to
             * every page is the tool's own: `Reset all` turns every page on, and so does emptying the box.
             */}
            <span className="tiny faint">The buttons below turn {target}.</span>
          </div>

          {/*
           * Each button names its own scope, because the visible label is only the angle. "90° clockwise" on its own is
           * a name shared with the angle badges on every tile — a person can see which buttons they are, and a screen
           * reader cannot, so the name is `Turn every page 90° clockwise` (or `Turn pages 2, 3 …`) and the visible text
           * is still inside it.
           */}
          <div className="rotate-actions">
            {TURNS.map((angle) => (
              <Button
                key={angle}
                size="sm"
                disabled={locked === true}
                aria-label={`Turn ${target} ${describeTurn(angle)}`}
                title={`Turn ${target} ${describeTurn(angle)}`}
                onClick={() => commit(setTurns(turns, angle, selection))}
              >
                {/*
                 * The same glyph the tiles use, and mirrored for the other direction: a quarter-turn arc with an
                 * arrowhead, so which way the button turns is readable before the label is. The half turn needs none —
                 * there is no direction to a half turn, and a glyph would have to invent one.
                 */}
                {angle === 180 ? null : (
                  <span className={angle === 270 ? 'rotate-glyph-flip' : undefined}>
                    <IconRotate size={13} />
                  </span>
                )}
                {describeTurn(angle)}
              </Button>
            ))}
            {/*
             *
             * **`Reset all` puts every page back to *as is*, not to a quarter turn.** It used to write
             * `uniformTurns(turns.length, 90)` — the tool's schema default applied to the whole document — which is an
             * arrangement *nobody asked for* arriving from the one control whose name promises to undo one. What it writes
             * now is the same option object the form opens with (`clearedRotation`): every page as it came in, the sentence
             * saying what turns it, Run waiting for a turn worth sending. It is also why the button is disabled when
             * nothing turns — there is nothing left to clear.
             */}
            <Button
              size="sm"
              variant="ghost"
              disabled={locked === true || worked === 0}
              aria-label="Reset every page to as it is"
              title="Take every page out of the rotation — the board goes back to the document as it came in"
              onClick={() => onTurns(clearedRotation())}
            >
              Reset all
            </Button>
          </div>

          <ol className="rotate-pages" aria-label="Pages and the way they will come out">
            {turns.map((turn, index) => {
              const page = index + 1;
              const untouched = turn === 0;
              // One page has to turn, so the last one standing cannot be switched off — and says so instead of being
              // clicked and doing nothing.
              const lastTurning = turn !== 0 && !canToggleTurn(turns, page);
              return (
                <li className="rotate-cell" key={page}>
                  <div className="rotate-tile" data-turn={turn} data-untouched={untouched}>
                    <button
                      type="button"
                      className="rotate-shot"
                      data-turn={turn}
                      aria-label={`Look closer at page ${page} of ${total ?? '?'} — ${describeTurn(turn)}`}
                      title="Look closer"
                      onClick={() => setOpenPage(page)}
                    >
                      <PagePreview
                        file={row.sourceFile}
                        page={page}
                        box={{ width: 150, height: 200 }}
                        alt={`Page ${page} of ${total ?? '?'}, ${describeTurn(turn)}`}
                      />
                    </button>

                    {/*
                     * The page's own switch. It reads as part of the plate the number sits in — the same plate the
                     * page plan's tiles use — and the two states are told apart by the plate itself: a page that turns
                     * carries the solid one, a page left as it is carries a hollow one. A pressed/unpressed button is
                     * also what makes the state legible to a screen reader, which the old `aria-hidden` number was not.
                     */}
                    <button
                      type="button"
                      className="rotate-pos"
                      data-untouched={untouched}
                      aria-pressed={turn !== 0}
                      disabled={locked === true || lastTurning}
                      aria-label={
                        lastTurning
                          ? `Page ${page}, the only page that turns`
                          : turn === 0
                            ? `Turn page ${page} with the rest of the document`
                            : `Leave page ${page} as it is`
                      }
                      title={
                        lastTurning
                          ? 'At least one page has to turn — this is the only one that does.'
                          : turn === 0
                            ? 'Turn this page again, at the angle the rest of the document is using'
                            : 'Leave this page exactly as it is'
                      }
                      onClick={() => commit(toggleTurn(turns, page))}
                    >
                      {page}
                    </button>
                    <span className="rotate-angle" data-untouched={untouched}>
                      {turnBadge(turn)}
                    </span>

                    {/*
                     * The tile's controls, in two rows: what a turn *does* on the first — the two quarter turns, and the
                     * `as is` switch that appears once there is a turn to take back — and what the page will come out as
                     * on the second.
                     *
                     * The angle was on the first row, after the buttons, and a 150px tile wrapped it under them anyway; it
                     * reads as a caption for the state the row above just changed, which is what it is.
                     */}
                    <span className="rotate-tile-body">
                      <span className="row" style={{ gap: 2 }}>
                        {/*
                         * The two quarter turns, and the anticlockwise one is the clockwise glyph mirrored: a rotation arc
                         * with an arrowhead says "this page turns", and the direction is the reflection.
                         */}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Turn page ${page} a quarter turn anticlockwise`}
                          disabled={locked === true}
                          onClick={() => commit(setTurns(turns, cycleTurn(turn, -1), [page]))}
                        >
                          <span className="rotate-glyph-flip">
                            <IconRotate size={14} />
                          </span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Turn page ${page} a quarter turn clockwise`}
                          disabled={locked === true}
                          onClick={() => commit(setTurns(turns, cycleTurn(turn, 1), [page]))}
                        >
                          <IconRotate size={14} />
                        </Button>
                        {/*
                         * **A page that turns gets a way back that says so.** The page number is that switch already
                         * (`toggleTurn`), and it is a switch only a reader who has been told about it can find — the number
                         * on a plate looks like a label. This one appears exactly when there is something to undo, and its
                         * name is the tool's own word for the state: *as is*.
                         *
                         * Disabled rather than hidden on the last page that turns: at least one page has to turn, and a
                         * control that accepts a click and does nothing is worse than one that says why (`canToggleTurn`).
                         */}
                        {turn === 0 ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={locked === true || lastTurning}
                            aria-label={`As is, page ${page}`}
                            title={
                              lastTurning
                                ? 'At least one page has to turn — this is the only one that does.'
                                : 'Take this page out of the rotation: it comes out exactly as it is'
                            }
                            onClick={() => commit(toggleTurn(turns, page))}
                          >
                            as is
                          </Button>
                        )}
                      </span>
                      <span className="tiny faint rotate-tile-state">{describeTurn(turn)}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>

          <span className="rotate-summary tiny" data-tone={summary.tone}>
            {summary.sentence}
          </span>

          {summary.tone === 'blocked' ? (
            <Alert tone="warning" title="This request cannot be sent as it stands">
              <span className="small">
                Turn at least one page — with ⟲ or ⟳ on a tile, or with a rotation button — and Run becomes available.
                The board writes what it draws, and an empty request is not "no rotation": the API's own default turns
                every page a quarter turn.
              </span>
            </Alert>
          ) : null}
        </div>
      </Card>

      {row.sourceFile && openPage != null ? (
        <PageLightbox
          file={row.sourceFile}
          name={row.name}
          page={openPage}
          pages={row.pages}
          onPage={(page) => setOpenPage(page)}
          onClose={() => setOpenPage(null)}
        />
      ) : null}
    </div>
  );
}
