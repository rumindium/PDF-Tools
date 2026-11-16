import type { OptionsUiField } from '@pdftools/contracts/tools';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Alert, Button, Field } from '../../components/ui';
import { uploadFile } from '../../lib/api-client';
import { SIGNATURE_DEFAULT_SIZE } from '../placement/shapes/signature';
import {
  EXPORT_SCALE,
  type InkPoint,
  type Stroke,
  exportSize,
  hasSignatureInk,
  inkBounds,
  placementForInk,
  trimRect,
} from './ink';

/**
 * The signature pad (`0-UI-DESIGN.md` §6.2).
 *
 * `sign` has three kinds — typed, drawn, image — and until this control existed only two of them were reachable: the
 * `drawn` path described a browser canvas export and the form asked the user to *upload* one, which means the option
 * was honest about the product and the product could not do it. The pad is the missing half: draw here, and the value
 * the option carries is still just a file id (`imageFileId`), because a signature that exists only on screen is not a
 * signature the job can place.
 *
 * Four decisions, and each of them is one of the ways this could have been wrong:
 *
 * 1. **The ink is uploaded, not embedded.** The pad exports a PNG, uploads it through the same `POST /files` the
 *    uploader uses, and stores the returned id. Nothing about the drawing is sent to the API as data — which keeps the
 *    attachment path (`auxiliaryFiles`, the size cap, `0-FILE-STORAGE.md`'s TTL) exactly as it is for someone who
 *    brought their own PNG. The two paths are one code path from the id onward.
 * 2. **Uploading is a button, and the state says which side of it you are on.** Auto-uploading after every stroke would
 *    create a file per stroke and a job could then be submitted with the *last* stroke's image while the user believes
 *    they sent the whole signature. So the pad uploads when asked, and until then it says — in words, next to the
 *    control — that what is on the pad is not what the job will place.
 * 3. **The export is cropped to the ink at 3×.** `ink.ts` holds that arithmetic with the reasons; the consequence in
 *    the UI is that the pad reports the aspect ratio it drew and the size to drag on the canvas below, so the placement
 *    does not squash the handwriting into whatever box the default happened to be.
 * 4. **A tap is not a signature.** `hasSignatureInk` refuses to call 4 px of ink a signature; the button is disabled
 *    with a reason rather than uploading a smudge that the engine will scale into the placement box.
 *
 * What it does not do, stated rather than implied: it does not smooth or pressure-model the strokes (a pointer gives
 * position only, and a guessed width would be a claim about a pen nobody is holding), and it does not verify that what
 * was drawn looks like a name.
 */

/** The pad's drawing area, in CSS pixels. Wide and short, because that is the shape of a signature. */
const PAD_WIDTH = 520;
const PAD_HEIGHT = 200;
/** Ink and stroke, chosen to survive the engine's placement rather than to match the app's palette: a signature is
 * scanned or printed against white paper in every real use. */
const INK_COLOUR = '#101418';
const INK_WIDTH = 2.4;

export interface SignaturePadProps {
  field: OptionsUiField;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  accepts: string[];
}

export function SignaturePad({ field, value, onChange, accepts }: SignaturePadProps) {
  const id = `option-${field.key}`;
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [live, setLive] = useState<Stroke | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whether the ink on the pad is the image the option currently names. Reset by any new stroke. */
  const [uploaded, setUploaded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const drawing = useRef(false);

  const current = value == null || value === '' ? null : String(value);

  // Repaint on every change of the ink. The context is scaled by the device pixel ratio so a stroke recorded in CSS
  // pixels is painted at the screen's resolution — and the *export* is scaled again (`EXPORT_SCALE`), which is why the
  // two factors are separate numbers.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    canvas.width = Math.round(PAD_WIDTH * ratio);
    canvas.height = Math.round(PAD_HEIGHT * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
    paint(context, live ? [...strokes, live] : strokes);
  }, [strokes, live]);

  function pointAt(event: ReactPointerEvent<HTMLCanvasElement>): InkPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    setLive([pointAt(event)]);
    setError(null);
    setUploaded(false);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const point = pointAt(event);
    setLive((stroke) => {
      if (!stroke) return stroke;
      const last = stroke[stroke.length - 1];
      // A pointer reports far more often than a hand moves, and 0.7 px is below what a screen can show: keeping every
      // sample would triple the stroke's points for no visible difference and make the export's bounding box a hair
      // wider than the ink.
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.7) return stroke;
      return [...stroke, point];
    });
  }

  function onPointerUp() {
    if (!drawing.current) return;
    drawing.current = false;
    setLive((stroke) => {
      if (stroke && stroke.length > 0) setStrokes((all) => [...all, stroke]);
      return null;
    });
  }

  const bounds = inkBounds(strokes);
  const drawable = hasSignatureInk(bounds);
  const rect = bounds ? trimRect(bounds, { width: PAD_WIDTH, height: PAD_HEIGHT }) : null;
  const suggested = rect ? placementForInk(rect, SIGNATURE_DEFAULT_SIZE) : null;

  async function send(blob: Blob, fileName: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const uploadedFile = await uploadFile(new File([blob], fileName, { type: blob.type || 'image/png' }), {
        kind: 'attachment',
      });
      onChange(field.key, uploadedFile.id);
      setName(uploadedFile.name ?? fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function useSignature(): Promise<void> {
    if (!rect) return;
    const size = exportSize(rect);
    const offscreen = document.createElement('canvas');
    offscreen.width = size.width;
    offscreen.height = size.height;
    const context = offscreen.getContext('2d');
    if (!context) {
      setError('This browser refused a 2D canvas, so the drawing cannot be exported.');
      return;
    }
    // Two transforms, in this order: scale the export up, then move the pad's ink so the crop's top-left is the
    // export's origin. Scaling first means the translate is in pad pixels, which is what `rect` is written in.
    context.scale(EXPORT_SCALE, EXPORT_SCALE);
    context.translate(-rect.x, -rect.y);
    paint(context, strokes);

    const blob = await new Promise<Blob | null>((resolve) => offscreen.toBlob(resolve, 'image/png'));
    if (!blob) {
      setError('The browser returned no image for the drawing.');
      return;
    }
    await send(blob, 'signature-drawn.png');
    setUploaded(true);
  }

  return (
    <Field label={field.label} hint={field.hint} htmlFor={id}>
      <div className="signature-pad stack-sm">
        <div
          ref={surfaceRef}
          className="signature-pad-surface"
          style={{ maxWidth: PAD_WIDTH }}
          onPointerDown={(event) => {
            // The pointer events live on the canvas, but a drag that starts on the surface's padding should not scroll
            // the form: the browser's default touch action is cancelled here, where the gesture begins.
            event.preventDefault();
          }}
        >
          <canvas
            id={id}
            ref={canvasRef}
            className="signature-pad-canvas"
            style={{ width: '100%', aspectRatio: `${PAD_WIDTH} / ${PAD_HEIGHT}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-label="Signature drawing area"
          />
          <span className="signature-pad-baseline" aria-hidden="true" />
        </div>

        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <Button size="sm" loading={busy} disabled={!drawable} onClick={() => void useSignature()}>
            Use this signature
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={strokes.length === 0}
            onClick={() => setStrokes((all) => all.slice(0, -1))}
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={strokes.length === 0 && !current}
            onClick={() => {
              setStrokes([]);
              setLive(null);
              setUploaded(false);
              onChange(field.key, undefined);
              setName(null);
            }}
          >
            Clear
          </Button>

          <label className="small muted" htmlFor={`${id}-file`} style={{ marginLeft: 'auto' }}>
            or upload a PNG
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept={accepts.length > 0 ? accepts.join(',') : 'image/png,image/jpeg'}
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void send(file, file.name);
            }}
          />
        </div>

        <span className="tiny muted">
          {!drawable
            ? 'Draw with a pointer or a finger, then press Use this signature — a short tap is not a signature.'
            : uploaded && current
              ? `Uploaded${name ? ` as ${name}` : ''}. The job pulls this file in as an attachment; drag a box of about ${suggested?.width ?? '—'} × ${suggested?.height ?? '—'} pt below so it is not squashed.`
              : `Drawn — not uploaded yet. Press Use this signature, or the job has no image to place. It will land at about ${suggested?.width ?? '—'} × ${suggested?.height ?? '—'} pt.`}
        </span>

        {current && !uploaded ? (
          <span className="tiny faint">
            The option currently names image {current.slice(0, 8)}…{name ? ` (${name})` : ''}, which is not what is
            drawn above.
          </span>
        ) : null}

        {error ? (
          <Alert tone="danger" title="The signature could not be uploaded">
            <span className="small">{error}</span>
          </Alert>
        ) : null}
      </div>
    </Field>
  );
}

/** Paint strokes in the pad's own units, on a context already scaled to whatever surface is being written to. */
function paint(context: CanvasRenderingContext2D, strokes: Stroke[]): void {
  context.strokeStyle = INK_COLOUR;
  context.fillStyle = INK_COLOUR;
  context.lineWidth = INK_WIDTH;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    if (stroke.length === 1) {
      const [only] = stroke as [InkPoint];
      // A dot, not nothing: `stroke()` on a single-point path draws nothing at all, and a tap should leave ink.
      context.beginPath();
      context.arc(only.x, only.y, INK_WIDTH / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    stroke.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.stroke();
  }
}
