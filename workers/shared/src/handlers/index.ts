/**
 * Handlers that belong to more than one pool.
 *
 * `merge` and `compress` declare an `escalate` threshold in the registry, so a large job is routed to `pdf-heavy`
 * (`docs/01-MERGE.md` §7: "> 1 000 pages or > 20 files goes to the `heavy` pool **with the same handler**"). The
 * heavy pool used to register a `NOT_IMPLEMENTED` stub for both, which meant the escalation path — the whole point
 * of the threshold — ended in a failed job named after a tool the user never chose.
 *
 * They live here rather than in one pool and imported across, because "the same handler" is the requirement: one
 * file, compiled once, running in whichever image the router picked. A copy per pool is how the light and heavy
 * images drift apart, which the workers Dockerfile goes out of its way to avoid.
 *
 * A handler's own imports are the test for whether it can live here: both of these use only `@pdftools/engines`,
 * `@pdftools/contracts`, `@pdftools/errors`, and `workers/shared`, and both engines they need (qpdf, Ghostscript)
 * are installed in both images.
 */

export { compress } from './compress';
export { merge } from './merge';
