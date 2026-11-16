/**
 * The error model from `docs/0-API.md` §7 — one shape, one list of codes.
 *
 * Both the API and the workers import this: the worker classifies an engine failure into a code,
 * the API maps that code to an HTTP status. Keeping the table here is what stops the two sides from
 * inventing their own names for the same failure.
 */

export const ERROR_CODES = {
  INVALID_FILE: 400,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  JOB_SIZE_EXCEEDED: 413,
  PAGE_LIMIT_EXCEEDED: 413,
  ENCRYPTED_INPUT: 422,
  // Not here: the plan's `PASSWORD_REQUIRED`. `EncryptOptions` refuses a request that carries neither password in its
  // own schema, naming both fields in the message, so this code would have been a second spelling of `VALIDATION_ERROR`
  // — and a published 422 that no code path can raise is a promise to the clients reading the table
  // (`docs/0-API.md` §7) that cannot come true. `10-PROTECT-AND-UNLOCK.md` §3 records it as the third name in this
  // category the implementation turned out not to need, beside `PASSWORD_POLICY_VIOLATION` and `ENCRYPTION_UNSUPPORTED`.
  WRONG_PASSWORD: 422,
  // A password the caller is *setting* is below what this service will put its name on (=== './tools/password-strength.ts').
  // `10-PROTECT-AND-UNLOCK.md` §3 sketched this as a 400; it is 422 for the same reason `VALIDATION_ERROR` is — the
  // request is well-formed and the JSON parsed, and what is wrong is the *value* the caller chose. 400 would tell a
  // client to look for a malformed body, which is the one thing that is not wrong here.
  WEAK_PASSWORD: 422,
  FILE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  JOB_EXPIRED: 410,
  JOB_CANCELLED: 409,
  VALIDATION_ERROR: 422,
  // Named by `docs/11-WATERMARK.md` §3 as its own code because the client can act on it: an unknown font is a
  // choice the user can change, unlike a conversion failure.
  FONT_NOT_FOUND: 422,
  // Also from `docs/11-WATERMARK.md` §3, and for the same reason: an image watermark whose image is missing, gone,
  // or not an image is something the user fixes by uploading one — `VALIDATION_ERROR` would say "some option is
  // wrong" when the actual answer is "upload the logo".
  IMAGE_REQUIRED: 422,
  // `12-PAGE-NUMBERS-HEADERS-FOOTERS.md` §3 names this one for a header logo whose image is missing or unusable, for
  // the same reason: the fix is "upload the logo", not "one of your options is wrong".
  LOGO_REQUIRED: 422,
  CONVERSION_FAILED: 500,
  CONVERSION_TIMEOUT: 504,
  ENGINE_UNAVAILABLE: 503,
  WORKER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  CONCURRENCY_LIMIT: 409,
  UNAUTHORIZED: 401,
  // "There is no account behind this request, and on this installation there does not have to be one." Its own code
  // rather than a second message under `UNAUTHORIZED`, because the client's next move is different in kind: an
  // invalid credential is a failure to report, while this one is an invitation to open a sign-in gate. Collapsing
  // them would leave the UI choosing between a red banner and a door on a string it has to parse
  // (`docs/0-TENANT-FIRST.md` §4.2).
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,

  // Codes that only ever appear inside a job (never as an HTTP status) — they are job failure
  // classifications, listed here so `jobs.error_code` has a closed vocabulary too.
  WORKER_LOST: 500,
  TOOL_NOT_IN_PLAN: 403,
  TOOL_DISABLED: 503,
  NOT_IMPLEMENTED: 501,
  UNSUPPORTED_CONTENT: 422,
  PAGE_LIMIT_EXCEEDED_JOB: 413,
  // `docs/08-PDF-TO-OFFICE-AND-TEXT.md` §3 names this as its own code rather than `CONVERSION_FAILED`: "no table here"
  // is a fact about the document the user can act on (different pages, OCR first), not a failure to convert.
  TABLE_NOT_FOUND: 422,
  // The same document names this one as the *failure* for an all-image selection, with `ocr` as the next action — the
  // difference from `UNSUPPORTED_CONTENT` being that it says which pages and what to do about them.
  IMAGE_ONLY_PAGES: 422,
  // `docs/14-SIGN-AND-FORMS.md` §3 gives the two form tools their own code for "this document has no AcroForm at all",
  // and the reason is the user's next action: a *scanned* form is the most common input, its fields are pixels, and
  // the answer is "run OCR first" rather than "one of your options is wrong". `VALIDATION_ERROR` would say the latter.
  NO_FORM_FIELDS: 422,
  // The same section's other half is a *warning*, and the plan's code for it is deliberately absent: a value that cannot
  // fit a field's type is `FIELD_SKIPPED` in the shipped `fill-form` (`workers/heavy/src/handlers/fill-form.ts`), beside
  // the field name the document does not have. A caller filling a 40-field form from a spreadsheet mistypes some rows,
  // and losing the other thirty-nine would be the wrong answer to that — which is why `FIELD_TYPE_MISMATCH` never got a
  // raise site and was removed from the vocabulary rather than published as an error no client could ever see.
  // `14-SIGN-AND-FORMS.md` §3 carries the correction.
  //
  // `14-SIGN-AND-FORMS.md` §3: a `sign` job with nothing to sign with. The contract's `fields` is `.min(1)`, so zero
  // *placements* is a `VALIDATION_ERROR` at the door; this code is for the other case — `kind: 'typed'` with no
  // `signature` text, where the job would otherwise ink an empty box and call it a signature.
  SIGNATURE_REQUIRED: 422,
  // The code for a job whose password was never written down and is no longer available: the API hands it to the
  // worker through a Redis key that expires, and this is what the worker reports if that key is gone (`secrets.ts`).
  // Retrying cannot help — a stash does not come back — so it is non-retryable and the user is told to submit again.
  SECRET_UNAVAILABLE: 500,
  // A handler was about to spawn an engine with a registered secret in its arguments, which is visible to every
  // process in the container via `/proc/<pid>/cmdline` (`0-SECURITY.md` §7.1). A programming error, not a document's
  // fault: the spawn is refused and the job stopped, because the alternative is a password in a process table.
  SECRET_IN_ARGV: 500,
  // The HTML tools are handed a document that references something the renderer would have to *fetch* — a URL, an
  // absolute path, or a path that walks out of the document. The conversion never fetches (`0-SECURITY.md` §7), so
  // the alternatives to this code were a silent hole where the asset should be, or a request this service must not
  // make. Its own code rather than `UNSUPPORTED_CONTENT` because the caller's next action is different: host the
  // asset beside the document and submit again.
  REMOTE_RESOURCES_BLOCKED: 422,
  // `docs/09-PDF-A.md` §5: an archival conversion that a validator rejected. The file is **not** delivered, because a
  // document whose metadata claims PDF/A and whose contents do not is worse than a failed job — an archive discovers
  // that years later, from an auditor. Its own code rather than `CONVERSION_FAILED` because the conversion *worked*:
  // the pipeline produced a file, and what failed is the claim about it.
  PDFA_CONFORMANCE_FAILED: 422,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Codes a client may see as an HTTP status. */
export type HttpErrorCode = Exclude<
  ErrorCode,
  | 'WORKER_LOST'
  | 'TOOL_NOT_IN_PLAN'
  | 'TOOL_DISABLED'
  | 'NOT_IMPLEMENTED'
  | 'UNSUPPORTED_CONTENT'
  | 'PAGE_LIMIT_EXCEEDED_JOB'
  | 'TABLE_NOT_FOUND'
  | 'IMAGE_ONLY_PAGES'
  | 'SECRET_UNAVAILABLE'
  | 'SECRET_IN_ARGV'
  | 'REMOTE_RESOURCES_BLOCKED'
  | 'PDFA_CONFORMANCE_FAILED'
>;

export const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  INVALID_FILE: 'The file could not be read. It may be corrupt or in an unexpected format.',
  UNSUPPORTED_FILE_TYPE: 'This tool does not accept that file type.',
  FILE_TOO_LARGE: 'The uploaded file exceeds the allowed size for your plan.',
  JOB_SIZE_EXCEEDED: 'The combined size of this job exceeds the allowed limit.',
  PAGE_LIMIT_EXCEEDED: 'This document has more pages than your plan allows in one job.',
  ENCRYPTED_INPUT: 'The document is password protected. Unlock it first, or provide the password.',
  WRONG_PASSWORD: 'The password was rejected. Check it and try again.',
  WEAK_PASSWORD: 'That password is too weak for the protection it would provide.',
  FILE_NOT_FOUND: 'That upload no longer exists. Please upload the file again.',
  JOB_NOT_FOUND: 'That job does not exist.',
  JOB_EXPIRED: 'The result was deleted when its retention window ended. Run the job again.',
  JOB_CANCELLED: 'The job was cancelled.',
  VALIDATION_ERROR: 'Some options are not valid for this tool.',
  FONT_NOT_FOUND: 'That font is not available. Choose one of the built-in fonts.',
  IMAGE_REQUIRED: 'An image watermark needs an uploaded PNG or JPEG. Upload one and use the file id it returns.',
  LOGO_REQUIRED: 'A header logo needs an uploaded PNG or JPEG. Upload one and use the file id it returns.',
  CONVERSION_FAILED: 'The conversion failed. Try another file or different options.',
  CONVERSION_TIMEOUT: 'The conversion exceeded its time budget.',
  ENGINE_UNAVAILABLE: 'The conversion engine is unavailable on this installation.',
  WORKER_UNAVAILABLE: 'No worker is available for this queue right now. Try again shortly.',
  RATE_LIMITED: 'Too many requests. Please slow down.',
  QUOTA_EXCEEDED: 'You have used your allowance for this period.',
  CONCURRENCY_LIMIT: 'You already have the maximum number of jobs running on your plan.',
  UNAUTHORIZED: 'Sign in to continue.',
  AUTH_REQUIRED: 'Sign in to run jobs. This installation does not serve anonymous visitors.',
  FORBIDDEN: 'You do not have access to this resource.',
  CONFLICT: 'The request conflicts with an earlier one.',
  INTERNAL_ERROR: 'Something went wrong on our side.',

  WORKER_LOST: 'The worker handling this job disappeared.',
  TOOL_NOT_IN_PLAN: 'This tool is not part of your current plan.',
  TOOL_DISABLED: 'This tool is temporarily disabled.',
  NOT_IMPLEMENTED: 'This tool is not implemented in this build yet.',
  UNSUPPORTED_CONTENT: 'The document contains content this tool cannot process.',
  PAGE_LIMIT_EXCEEDED_JOB: 'This document has more pages than the plan allows in one job.',
  TABLE_NOT_FOUND:
    'No table was found in the selected pages. Scanned pages need OCR first, and a table needs either drawn rules or clearly aligned columns.',
  IMAGE_ONLY_PAGES:
    'Every selected page is an image with no text layer, so there is nothing to rebuild as editable content. Run the document through the OCR tool first.',
  NO_FORM_FIELDS:
    'This document has no fillable form. If it is a scan, its fields are pixels rather than a form — run it through the OCR tool first, or place a signature with the sign tool.',
  SIGNATURE_REQUIRED:
    'This job has nothing to sign with. A typed signature needs the name to render, and a drawn or uploaded one needs its image.',
  SECRET_UNAVAILABLE:
    'The password for this job is no longer held by the service, because it is never stored with the job. Submit the job again.',
  SECRET_IN_ARGV:
    'The job was stopped because it was about to pass a password on a command line, where every process in the container could read it.',
  REMOTE_RESOURCES_BLOCKED:
    'This document references a resource the converter never fetches — a URL, an absolute path, or a path outside the document. Put the file beside the HTML, or include it in the uploaded bundle.',
  PDFA_CONFORMANCE_FAILED:
    'The converted document did not pass PDF/A validation, so it has not been delivered. A file that claims PDF/A without conforming is worse than no file: try again with forceSrgb on, or convert with a simpler source document.',
};

export function statusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}

export function messageFor(code: ErrorCode, fallback?: string): string {
  return fallback && fallback.trim().length > 0 ? fallback : DEFAULT_MESSAGE[code];
}

/**
 * Failure classes from `docs/0-QUEUE-AND-JOBS.md` §1.
 * `retryable` is what the worker reports to the queue; the API never sees it.
 */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INTERNAL_ERROR',
  'ENGINE_UNAVAILABLE',
  'WORKER_LOST',
  'WORKER_UNAVAILABLE',
  'CONVERSION_FAILED',
]);

export const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INVALID_FILE',
  'UNSUPPORTED_FILE_TYPE',
  'UNSUPPORTED_CONTENT',
  'ENCRYPTED_INPUT',
  'WRONG_PASSWORD',
  'VALIDATION_ERROR',
  'IMAGE_REQUIRED',
  'LOGO_REQUIRED',
  'SIGNATURE_REQUIRED',
  'PAGE_LIMIT_EXCEEDED',
  'PAGE_LIMIT_EXCEEDED_JOB',
  'JOB_SIZE_EXCEEDED',
  'FILE_TOO_LARGE',
  'NOT_IMPLEMENTED',
  'TOOL_DISABLED',
  // Nothing about retrying turns a page with no rules and no alignment into a table (`docs/08-…` §2).
  'TABLE_NOT_FOUND',
  // Nor does retrying put a text layer into a scan.
  'IMAGE_ONLY_PAGES',
  // A timeout usually means the input is too large for the budget — retrying times out again.
  'CONVERSION_TIMEOUT',
  // A stash does not come back: the value was held only for this job's lifetime, so a retry would fail the same way
  // and would waste an attempt proving it (`secrets.ts`).
  'SECRET_UNAVAILABLE',
  // A retry would spawn the same command with the same arguments and expose the same password again. The handler is
  // wrong, not the input, so failing once and loudly is the whole remedy (`packages/engines/src/run.ts`).
  'SECRET_IN_ARGV',
  // The document asks for a resource that is not in it; retrying will not put it there.
  'REMOTE_RESOURCES_BLOCKED',
  // The same document, the same pipeline and the same validator produce the same verdict. A retry would spend the
  // whole conversion again to be told the same thing, so the failure is reported once and the caller decides.
  'PDFA_CONFORMANCE_FAILED',
]);
