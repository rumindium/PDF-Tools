/**
 * The API's door onto the shared event writer.
 *
 * The implementation lives in `@pdftools/queue` so the API and the workers write events through exactly one code
 * path — an event that is written but not published (or published but not written) breaks SSE replay in a way
 * that only shows up when a user reconnects at the wrong moment.
 */
export {
  recordEvent,
  eventsSince,
  subscribeToJob,
  type JobEventInput,
  type JobEventType,
  type PersistedJobEvent,
} from '@pdftools/queue';
