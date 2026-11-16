import type { UploadedFile } from '@pdftools/contracts/api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconUpload } from '../../components/icons';
import { ApiError, uploadFile } from '../../lib/api-client';
import { formatBytes } from '../../lib/format';
import { hasFilePayload, markDropHandled, typeRejection, wasDropHandled } from './drop';
import { type BoardRow, boardRows, moveRow, reconcileOrder } from './order';

/**
 * Uploader (`docs/0-FOLDER-STRUCTURE.md` §3, `features/uploader/`).
 *
 * Uploads start the moment a file is chosen and run at `UPLOAD_CONCURRENCY` at a time. Two reasons this is not a
 * single "submit" button:
 *
 *  - the user sees a per-file progress bar instead of one frozen screen, and a rejected file is identified by
 *    name in seconds rather than after the whole batch;
 *  - the API's job creation wants file ids, so uploading eagerly is also what makes "same file, second tool"
 *    free — the bytes are already staged.
 *
 * Client-side checks are *advisory only*. A name and a size are claims; the API detects the type from magic bytes
 * (`0-SECURITY.md` §3) and enforces the plan's ceiling, and its answer is the one that counts.
 *
 * The hook also owns the **order** (`features/uploader/order.ts`). It has to: the order is a list of file ids, so it
 * is a function of the uploads, and the two kept apart are the two that drift — a reorder lost because a second
 * upload finished, or a file removed from the list but not from the merge.
 */

export type UploadState = 'pending' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  localId: string;
  file: File;
  progress: number;
  state: UploadState;
  error: string | null;
  errorCode: string | null;
  uploaded: UploadedFile | null;
}

const FILE_INPUT_ACCEPT: Partial<Record<string, string>> = {
  pdf: '.pdf,application/pdf',
  image: '.jpg,.jpeg,.png,.webp,.heic,.heif,.tif,.tiff,image/*',
  office: '.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.rtf,.csv,.txt',
  html: '.html,.htm',
  zip: '.zip',
};

export function acceptAttributeFor(accepts: string[]): string {
  const parts = new Set<string>();
  for (const mime of accepts) {
    if (mime === 'application/pdf') parts.add(FILE_INPUT_ACCEPT.pdf!);
    else if (mime.startsWith('image/')) parts.add(FILE_INPUT_ACCEPT.image!);
    else if (
      mime.includes('officedocument') ||
      mime.includes('msword') ||
      mime.includes('ms-excel') ||
      mime.includes('ms-powerpoint') ||
      mime === 'text/plain' ||
      mime === 'text/csv' ||
      mime.startsWith('application/vnd.oasis')
    ) {
      parts.add(FILE_INPUT_ACCEPT.office!);
    } else if (mime === 'text/html') parts.add(FILE_INPUT_ACCEPT.html!);
    else if (mime === 'application/zip') parts.add(FILE_INPUT_ACCEPT.zip!);
  }
  parts.add('application/pdf');
  return [...parts].join(',');
}

export interface UseUploadsOptions {
  maxFiles: number;
  maxFileMb: number;
  acceptAttribute: string;
  /** How many uploads may be in flight at once. Mirrors `UPLOAD_CONCURRENCY` on the server. */
  concurrency?: number;
}

export interface UploadsController {
  items: UploadItem[];
  /** Every uploaded file, in upload order — what an option that takes a file wants (`watermark.imageFileId`). */
  files: UploadedFile[];
  /** The same files in the order the user arranged, which is what a job submits. */
  orderedFiles: UploadedFile[];
  order: string[];
  reorder: (from: number, to: number) => void;
  addFiles: (files: FileList | File[]) => void;
  removeItem: (localId: string) => void;
  reset: () => void;
  retry: (localId: string) => void;
  uploading: boolean;
  rejections: string[];
  clearRejections: () => void;
}

export function useUploads(options: UseUploadsOptions): UploadsController {
  const { maxFiles, maxFileMb, acceptAttribute, concurrency = 3 } = options;
  const [items, setItems] = useState<UploadItem[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const inFlight = useRef(0);
  const queue = useRef<Array<{ localId: string; file: File }>>([]);
  const counter = useRef(0);

  const patch = useCallback((localId: string, changes: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)));
  }, []);

  const pump = useCallback(() => {
    while (inFlight.current < concurrency && queue.current.length > 0) {
      const next = queue.current.shift()!;
      inFlight.current += 1;
      patch(next.localId, { state: 'uploading', progress: 0, error: null, errorCode: null });

      uploadFile(next.file, {
        kind: 'input',
        onProgress: (percent) => patch(next.localId, { progress: percent }),
      })
        .then((uploaded) => {
          patch(next.localId, { state: 'done', progress: 100, uploaded });
        })
        .catch((cause: unknown) => {
          const apiError = cause instanceof ApiError ? cause : null;
          patch(next.localId, {
            state: 'error',
            error: apiError?.message ?? 'The upload failed.',
            errorCode: apiError?.code ?? null,
          });
        })
        .finally(() => {
          inFlight.current -= 1;
          pump();
        });
    }
  }, [concurrency, patch]);

  const startUpload = useCallback(
    (localId: string, file: File) => {
      queue.current.push({ localId, file });
      pump();
    },
    [pump],
  );

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = [...incoming];
      const rejected: string[] = [];
      const accepted: Array<{ localId: string; file: File }> = [];
      // Room is measured against the files already accepted, and the order of the checks follows `0-UI-DESIGN.md` §5:
      // the wrong type is the one thing a person can fix without knowing anything about their plan, so it is said first.
      const room = Math.max(0, maxFiles - items.length);

      for (const file of list) {
        const wrongType = typeRejection({ name: file.name, type: file.type }, acceptAttribute);
        if (wrongType) {
          rejected.push(wrongType);
          continue;
        }
        if (file.size > maxFileMb * 1024 * 1024) {
          rejected.push(`${file.name} — ${formatBytes(file.size)} is above the ${maxFileMb} MB limit on your plan.`);
          continue;
        }
        if (file.size === 0) {
          rejected.push(`${file.name} — the file is empty.`);
          continue;
        }
        if (accepted.length >= room) {
          rejected.push(`${file.name} — this tool accepts at most ${maxFiles} file${maxFiles === 1 ? '' : 's'}.`);
          continue;
        }
        counter.current += 1;
        accepted.push({ localId: `u${counter.current}-${file.name}`, file });
      }

      setRejections(rejected);
      if (accepted.length === 0) return;

      const created: UploadItem[] = accepted.map(({ localId, file }) => ({
        localId,
        file,
        progress: 0,
        state: 'pending',
        error: null,
        errorCode: null,
        uploaded: null,
      }));

      setItems((current) => [...current, ...created]);
      // Kick the uploads off after state is committed so the progress callbacks have rows to update.
      queueMicrotask(() => {
        for (const entry of accepted) startUpload(entry.localId, entry.file);
      });
    },
    [acceptAttribute, items.length, maxFileMb, maxFiles, startUpload],
  );

  const removeItem = useCallback((localId: string) => {
    setItems((current) => current.filter((item) => item.localId !== localId));
    queue.current = queue.current.filter((entry) => entry.localId !== localId);
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const item = items.find((entry) => entry.localId === localId);
      if (!item) return;
      patch(localId, { state: 'pending', error: null, errorCode: null, progress: 0 });
      startUpload(localId, item.file);
    },
    [items, patch, startUpload],
  );

  const reset = useCallback(() => {
    setItems([]);
    setRejections([]);
    setOrder([]);
    queue.current = [];
  }, []);

  const files = useMemo(
    () => items.map((item) => item.uploaded).filter((file): file is UploadedFile => file != null),
    [items],
  );

  // One reconcile per upload-list change, and it is the only writer of the order besides a deliberate move: a file
  // arriving or leaving adjusts the list, it never rebuilds it (`reconcileOrder` documents why).
  const fileIds = useMemo(() => files.map((file) => file.id), [files]);
  useEffect(() => {
    setOrder((current) => reconcileOrder(current, fileIds));
  }, [fileIds]);

  const reorder = useCallback((from: number, to: number) => {
    setOrder((current) => moveRow(current, from, to));
  }, []);

  const orderedFiles = useMemo(() => {
    const byId = new Map(files.map((file) => [file.id, file]));
    const placed = order.map((id) => byId.get(id)).filter((file): file is UploadedFile => file != null);
    const placedIds = new Set(placed.map((file) => file.id));
    // Anything not in the order yet (an upload that finished in the same tick) still has to be submitted, or a file
    // the user can see would be silently left out of the job.
    return [...placed, ...files.filter((file) => !placedIds.has(file.id))];
  }, [files, order]);

  return {
    items,
    files,
    orderedFiles,
    order,
    reorder,
    addFiles,
    removeItem,
    reset,
    retry,
    uploading: items.some((item) => item.state === 'uploading' || item.state === 'pending'),
    rejections,
    clearRejections: () => setRejections([]),
  };
}

/**
 * A page-wide drop target, and whether a file is currently over the window.
 *
 * The zone is a target you have to aim at; a page that accepts a file anywhere is the behaviour people actually
 * expect from a workspace, and the overlay is what keeps it honest — dropping on a random part of the page does
 * something, and the overlay says what before the mouse button is released.
 *
 * The zone's own drop is marked handled (`drop.ts`), so a drop on the zone is added once and not twice: both handlers
 * see the same event, and without the mark the page-level listener would add the same File objects again.
 */
export function usePageDrop({
  enabled,
  onFiles,
}: {
  enabled: boolean;
  onFiles: (files: File[]) => void;
}): boolean {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setDragging(false);
      return;
    }
    // `dragenter`/`dragleave` fire for every element the pointer crosses, so the depth counter is what tells
    // "left the window" apart from "moved onto a child".
    let depth = 0;
    const carriesFiles = (event: DragEvent) => hasFilePayload(event.dataTransfer?.types);

    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser refuses the drop and opens the file instead, which navigates away from the page.
      event.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (wasDropHandled(event) || !carriesFiles(event)) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) handler.current(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);

  return dragging;
}

/**
 * `Ctrl/Cmd+V` on a tool page, for a screenshot or a PDF copied from somewhere else.
 *
 * Nothing is claimed when the caret is in a field: pasting into a text box is a text paste, and a hook that swallowed
 * it would make the page's own options unusable. The clipboard is read for *files* only.
 */
export function useClipboardPaste({
  enabled,
  onFiles,
}: {
  enabled: boolean;
  onFiles: (files: File[]) => void;
}): void {
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      handler.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [enabled]);
}

/** The drop target itself. Keyboard-accessible: the whole zone is a button. */
export function Dropzone({
  onFiles,
  accept,
  multiple,
  disabled,
  hint,
  compact = false,
}: {
  onFiles: (files: FileList | File[]) => void;
  accept: string;
  multiple: boolean;
  disabled?: boolean;
  hint?: string;
  /** Less padding once there is already something in the list, without shrinking the target below a comfortable size. */
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  return (
    <>
      {/*
        Disabled with the zone, not just hidden: the button below is what a person can reach, but a file input left
        live is a picker that can still be opened by anything else that finds it, and the upload it would start is the
        one the disabled zone exists to prevent (`docs/0-TENANT-FIRST.md` §4.2 — a gated caller's upload is a 401).
      */}
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        style={{ display: 'none' }}
        onChange={(event) => {
          if (event.currentTarget.files) onFiles(event.currentTarget.files);
          // Reset so choosing the same file twice still fires a change event.
          event.currentTarget.value = '';
        }}
      />
      {/*
        A real `<button>`, not a `div` with `role="button"`: the zone's whole job is "activate this", so the
        browser's own click-on-Enter/Space, focus ring, and disabled handling are exactly what is wanted — the
        hand-written `onKeyDown` and `aria-disabled` were re-implementing them. `data-disabled` stays because the
        stylesheet keys its dimmed state off it, and the children are `<span>`s because a button may only contain
        phrasing content.
      */}
      <button
        type="button"
        className="dropzone"
        data-active={active}
        data-disabled={disabled}
        data-compact={compact}
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setActive(true);
        }}
        onDragLeave={() => setActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setActive(false);
          // Told to the page-level listener, which sees the same event a moment later and must not add it again.
          markDropHandled(event.nativeEvent);
          if (!disabled && event.dataTransfer?.files) onFiles(event.dataTransfer.files);
        }}
      >
        <span className="stack-sm" style={{ alignItems: 'center', gap: compact ? 2 : 6 }}>
          {/*
            The zone's glyph, hidden in the compact state: expanded, the zone is the page's one instruction and the icon
            is what says so at a glance; compact, it sits above a list that already has the user's attention.
          */}
          <span className="dropzone-icon" aria-hidden="true">
            <IconUpload size={compact ? 16 : 24} />
          </span>
          <span className="strong">Drop {multiple ? 'files' : 'a file'} here</span>
          <span className="small muted">or click to browse</span>
          {hint ? <span className="tiny faint">{hint}</span> : null}
        </span>
      </button>
    </>
  );
}

/**
 * The board's rows for a set of uploads: the page's one-line bridge between what is uploading and what is ordered.
 *
 * `uploads.items` is the truth about bytes; `order` is the truth about arrangement; `files` is the truth about what the
 * API accepted. The board is a drawing of all three, and this is where they are joined.
 */
export function boardInputs(items: UploadItem[], order: string[], files: UploadedFile[]): BoardRow[] {
  return boardRows(
    items.map((item) => ({
      localId: item.localId,
      name: item.uploaded?.name ?? item.file.name,
      sizeBytes: item.file.size,
      state: item.state,
      progress: item.progress,
      error: item.error,
      errorCode: item.errorCode,
      uploadedId: item.uploaded?.id ?? null,
      // The tile draws the file the user picked (`features/preview/`), which the browser already holds.
      sourceFile: item.file,
    })),
    order,
    files,
  );
}

export { DocumentRow } from './document-row';
export { FilesBoard } from './board';
export type { BoardRow, OrderSegment, OrderRow } from './order';
export { boardRows, describeOrder, orderSegments, summarizeOrder } from './order';
