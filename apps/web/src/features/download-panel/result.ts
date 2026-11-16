import { formatBytes } from '../../lib/format';

/**
 * What the result panel says about the file, as arithmetic rather than as markup.
 *
 * Both functions below are the panel's *claims*, and a claim is exactly what has to be testable: "every page is
 * accounted for" is the sentence a user reads to decide whether to trust the output, and a comparison that quietly
 * compares a partial sum, or a countdown that says "29 minutes" when the file is already gone, are worse than no
 * sentence at all.
 */

export interface Verdict {
  tone: 'success' | 'warning' | 'neutral';
  label: string;
  detail: string;
}

/**
 * The input-versus-output comparison (`docs/0-UI-DESIGN.md` §3.3, `01-MERGE.md` §6).
 *
 * `null` when there is nothing honest to compare: one of the two counts is unknown. Refusing to compare is a decision,
 * not a gap — a merge whose input count the API could not probe would otherwise be labelled "0 pages in, 84 out".
 */
export function comparePages(inputPages: number | null, outputPages: number | null): Verdict | null {
  if (inputPages == null || outputPages == null) return null;
  if (inputPages === outputPages) {
    return {
      tone: 'success',
      label: 'Every page accounted for',
      detail: `${inputPages} page${inputPages === 1 ? '' : 's'} in, ${outputPages} out.`,
    };
  }
  if (outputPages > inputPages) {
    // More pages than went in is unusual for every tool this product ships, so it is said out loud rather than
    // presented as a normal outcome.
    return {
      tone: 'warning',
      label: `${outputPages - inputPages} page${outputPages - inputPages === 1 ? '' : 's'} more than went in`,
      detail: `${inputPages} pages in, ${outputPages} out.`,
    };
  }
  return {
    tone: 'neutral',
    label: `${inputPages - outputPages} page${inputPages - outputPages === 1 ? '' : 's'} fewer than went in`,
    detail: `${inputPages} pages in, ${outputPages} out — a tool that reassembles pages can produce fewer.`,
  };
}

/** One side of the comparison, so both sides are phrased by the same code. */
export function describeInputs(files: number, pages: number | null, bytes: number): string {
  const parts = [`${files} file${files === 1 ? '' : 's'}`];
  if (pages != null) parts.push(`${pages} page${pages === 1 ? '' : 's'}`);
  parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

/**
 * How long the result will still be downloadable (`0-API.md` §4.5 — the download works exactly while the row does).
 *
 * Computed from the server's own deadline against a clock the caller supplies, so the countdown is a rendering of the
 * API's answer and not a second opinion about it. The 30-minute retention `0-DATA.md` describes belongs to the plan,
 * and the deadline that matters is the one the job row carries.
 */
export function describeRetention(
  expiresAt: string | null | undefined,
  now: number,
): { expired: boolean; label: string } {
  if (!expiresAt) return { expired: false, label: 'Retention follows your plan.' };
  const deadline = new Date(expiresAt).getTime();
  if (!Number.isFinite(deadline)) return { expired: false, label: 'Retention follows your plan.' };
  const remaining = deadline - now;
  if (remaining <= 0) return { expired: true, label: 'This result has been deleted.' };
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return { expired: false, label: 'Deleted in less than a minute.' };
  if (minutes < 60) return { expired: false, label: `Deleted in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return { expired: false, label: `Deleted in ${hours}h${rest > 0 ? ` ${rest}m` : ''}.` };
  }
  return { expired: false, label: `Deleted in ${Math.round(hours / 24)} days.` };
}
