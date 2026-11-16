import type { OptionsUiField } from '@pdftools/contracts/tools';
import type { ReactNode } from 'react';
import type { Box, DisplayGeometry, Point } from './geometry';
import { annotationsAdapter } from './shapes/annotations-adapter';
import { elementsAdapter } from './shapes/elements';
import { redactionsAdapter } from './shapes/redactions-adapter';
import { signatureAdapter } from './shapes/signature-adapter';

/**
 * One placed mark, as the canvas holds it.
 *
 * The canvas is deliberately blind to the entry's fields: it knows a kind, a page and a rectangle, and asks the
 * shape adapter for everything else. That is what lets one canvas serve two contracts whose entries have nothing in
 * common structurally — `edit-pdf` puts the box on the entry and sizes text by its font, `annotate` groups boxes in a
 * `rects` array and anchors a note at a point — without a condition per tool inside the canvas.
 */
export interface PlacementItem {
  /** The kind it was placed as: `text`, `highlight`, `note`… Always one the catalog declared. */
  kind: string;
  page: number;
  /** The object as the contract spells it, carried through whole so no field the schema accepted is lost. */
  entry: Record<string, unknown>;
}

/**
 * Everything the canvas needs to know about a tool's placement shape.
 *
 * Four implementations exist, and the reason they are modules rather than switches is that each one is a set of
 * decisions a reader has to be able to see: what a rectangle *means* for this contract, what a new mark of each kind
 * looks like, and which fields a row offers. The third arrived with the contract that needed it most — `sign`'s
 * coordinates are written in points, millimetres *or* a share of the page, and that conversion is a decision the canvas
 * itself must not make (`shapes/signature.ts`). The fourth, `redactions`, is the one whose wrong value would be
 * invisible in its output and in its metrics — a box that missed its target still produces a valid, successful job, and
 * the document still holds what the user believed was gone (`shapes/redactions.ts`).
 */
export interface PlacementAdapter {
  /** Toolbar entries, in the catalog's order. */
  kinds: Array<{ id: string; label: string }>;
  /** The word for one mark, used in the list's own sentences (`"3 elements"`, `"2 annotations"`). */
  noun: string;
  read(value: unknown): PlacementItem[];
  /** The rectangle the canvas draws, drags and resizes for this mark — `null` when it has no geometry yet. */
  box(item: PlacementItem): Box | null;
  move(item: PlacementItem, box: Box): PlacementItem;
  create(kind: string, page: number, box: Box): PlacementItem;
  summary(item: PlacementItem): string;
  /**
   * How a mark of this kind is placed.
   *
   * `point` kinds are put down by a click at their default size — a text element is anchored at its baseline and sized
   * by its font, a checkbox is a fixed square, a note is one 20 pt icon box — so the canvas offers no resize handle for
   * them rather than a handle that silently does nothing.
   */
  geometry(kind: string): 'box' | 'point';
  defaultSize(kind: string): { width: number; height: number };
  /** Kinds built up by repeated clicks instead of one drag (`edit-pdf`'s freehand stroke). Empty for most shapes. */
  strokeKinds: string[];
  addStrokePoint(item: PlacementItem, at: Point): PlacementItem;
  /** What the canvas draws *inside* a mark's box: a text preview, a stroke's path, a mark's own colour. */
  overlay(item: PlacementItem, geometry: DisplayGeometry): ReactNode;
  /**
   * The text this mark carries **as the page draws it**, or `null` for a kind whose content is not typed on the page.
   *
   * This is the canvas's fourth control, and the only one that is *in* the drawing: a selected text mark is clicked a
   * second time and an input appears where the words are, in the words' own size, colour and **face**, so a caption is
   * written where it will be read rather than in a field below the document. A kind with nothing to type answers `null`
   * — a checkbox is a tick, a stroke is a path, an image is a file — and a shape may leave the pair undefined.
   *
   * The face belongs here rather than being looked up by the canvas for one reason: `edit-pdf`'s box is measured in the
   * metrics of that face, and the canvas measures it from this same value (`textWidthPoints`), so the field and the box
   * are the same width by construction rather than by two callers remembering to agree.
   */
  textOf?(item: PlacementItem): { text: string; size: number; color: string; font: string } | null;
  /** The same mark with that text replaced — the half that makes `textOf` a control rather than a read-out. */
  withText?(item: PlacementItem, text: string): PlacementItem;
  /** The row's fields, rendered by the shape that knows which fields its contract has. */
  fields(item: PlacementItem, update: (next: PlacementItem) => void, index: number): ReactNode;
}

/** The shapes this build can draw. One entry per `placement.shape` the catalog is allowed to name. */
const ADAPTERS: Record<string, PlacementAdapter> = {
  'edit-elements': elementsAdapter,
  annotations: annotationsAdapter,
  signature: signatureAdapter,
  redactions: redactionsAdapter,
};

/**
 * The adapter a catalog field asks for.
 *
 * `shape` is required by the declaration, so a missing one is a catalog bug rather than a silent fallback: the canvas
 * would otherwise switch to writing another tool's entry layout, which is a payload the API would reject or — worse —
 * accept and ignore. Returning `null` lets the panel say so instead of guessing.
 */
export function adapterFor(field: OptionsUiField): PlacementAdapter | null {
  const shape = field.placement?.shape;
  if (!shape) return null;
  return ADAPTERS[shape] ?? null;
}
