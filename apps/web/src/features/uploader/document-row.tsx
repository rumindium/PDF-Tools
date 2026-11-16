import { IconFileText, IconX } from '../../components/icons';
import { Alert, Badge, Button } from '../../components/ui';
import { formatBytes } from '../../lib/format';
import { PagePreview } from '../preview';
import type { BoardRow } from './order';

/**
 * The one document a single-input tool is about: its first page, its facts, and the three things a person does to it.
 *
 * Extracted from the plan preview (`features/page-plan/`) the moment a second preview needed the same row — the order
 * board draws the same document, and a copy of this markup would be a second place for the `Ready` badge, the retry path
 * and the size formatting to drift out of step. Its class names stay `plan-file*` because they are the styles both
 * previews wear: this is a row of *the document*, not of any particular plan.
 *
 * The thumbnail is the first page rather than an icon, because "is this the right file" is a glance for a PDF and a guess
 * for a filename — and a file this browser cannot draw (an office document, a PDF still uploading) keeps its row, its
 * name and its size, with a glyph in place of the picture. Losing the preview must never lose the row.
 *
 * No remove button is drawn for an upload that has no id yet: there is nothing on the server to delete, and the retry
 * path beside it is the action a failed upload actually needs. `Preview` stays available while the upload is in flight,
 * because the bytes being previewed are the browser's own copy — the page renders from the `File` the person dropped.
 */
export function DocumentRow({
  row,
  onRemove,
  onRetry,
  onPreview,
}: {
  row: BoardRow;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onPreview: () => void;
}) {
  return (
    <div className="stack">
      <div className="plan-file">
        <span className="plan-file-thumb">
          <PagePreview
            file={row.sourceFile}
            page={1}
            box={{ width: 120, height: 156 }}
            alt={row.sourceFile ? `First page of ${row.name}` : `${row.name} — no page preview for this file type`}
            empty={<IconFileText size={18} />}
          />
        </span>

        <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <span className="small strong truncate" title={row.name}>
            {row.name}
          </span>
          <span className="tiny faint">
            {row.pages != null ? `${row.pages} page${row.pages === 1 ? '' : 's'}` : 'page count unknown'} ·{' '}
            {formatBytes(row.sizeBytes)}
          </span>
          {row.state !== 'done' ? (
            <span className="tiny faint">
              {row.state === 'uploading'
                ? `Uploading ${row.progress}%`
                : row.state === 'pending'
                  ? 'Waiting…'
                  : 'Failed'}
            </span>
          ) : null}
        </span>

        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          {/* The word the browser cases and the user both look for: the API accepted the bytes and handed back an id. */}
          {row.state === 'done' ? <Badge tone="success">Ready</Badge> : null}
          {row.state === 'error' && row.localId ? (
            <Button size="sm" onClick={() => onRetry(row.localId!)}>
              Retry
            </Button>
          ) : null}
          {row.sourceFile ? (
            <Button size="sm" variant="ghost" onClick={onPreview}>
              Preview
            </Button>
          ) : null}
          {row.localId ? (
            <Button size="sm" variant="ghost" aria-label={`Remove ${row.name}`} onClick={() => onRemove(row.localId!)}>
              <IconX size={14} />
            </Button>
          ) : null}
        </span>
      </div>

      {row.error ? (
        <Alert tone="danger" title="That upload failed">
          <span className="tiny">{row.error}</span>
        </Alert>
      ) : null}
    </div>
  );
}
