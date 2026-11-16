/**
 * The worker's door onto the shared event writer.
 *
 * `runtime.ts` imports this lazily (inside the job body) rather than at module scope, so that a handler test can
 * import the runtime without a database. The implementation itself lives in `@pdftools/queue` and is shared with
 * the API — the API's `event-service.ts` re-exports the same three functions. One writer, two callers: an event
 * that is persisted but not published (or the reverse) breaks SSE replay in the way that only shows up when a
 * client reconnects at the wrong moment.
 */
export {
  recordEvent,
  eventsSince,
  subscribeToJob,
  type JobEventInput,
  type JobEventType,
  type PersistedJobEvent,
} from '@pdftools/queue';
