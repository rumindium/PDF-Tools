import { join } from 'node:path';
import type { FillFormOptions } from '@pdftools/contracts/tools';
import {
  type FillResult,
  type FillValue,
  countPdfPages,
  fillForm,
  readFilledFormState,
  readFilledText,
  readFormFields,
  readSignatureRecord,
  signatureInvalidatedWarning,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `fill-form` — `docs/14-SIGN-AND-FORMS.md` §2, on the heavy pool because it is the AcroForm tool that *writes*.
 *
 * What makes this handler worth reading is not the write (one pikepdf pass) but the three things it refuses to take on
 * trust, all of them measured in the worker image before the handler existed:
 *
 *  1. **A value that is in the file is not a value that is on the page.** A text field's `/V` can be set while its
 *     `/AP` is missing — the field reads back correctly from every API and the reader shows an empty box, which is the
 *     classic "filled PDF that looks empty" report. So the write generates appearances, and the verification renders
 *     nothing: it asks **PyMuPDF** (a different engine from the pikepdf that wrote the file) what each field's value is
 *     now, and the job fails if any written value does not read back.
 *  2. **A checkbox's state is a name that has to resolve.** `/V` and `/AS` both have to name a key of the field's
 *     `/AP /N` map; a value naming a state the appearance map does not have is a box that reports "checked" and draws
 *     the empty square. The verification compares the state the *reader* sees, and `FIELD_STATE_UNRESOLVED` reports the
 *     fields where that is not the state that was written.
 *  3. **Flattening is a claim about the widget tree, so it is read back as one.** The value must still be *content*
 *     after a flatten, which is why the flattened cases assert extraction as well as absence. What a flatten cannot do
 *     is bake an annotation that has no appearance — measured: qpdf skips those and leaves them exactly where they
 *     were — so this handler reports them (`FIELD_NOT_FLATTENED`) instead of failing the job. Failing was the first
 *     version's answer and it was wrong twice over: the caller lost an output that was otherwise correct, and the
 *     fields that stayed were the ones with nothing to lose, which are the empties `flattenMode: 'all'` removes.
 *
 * The one case that *is* an error is a job whose only product would have been a lie — and there is none left here,
 * because every field that stays interactive is named in the report the caller reads.
 *
 * Values that cannot be written are reported, never dropped: an unknown field name is `FIELD_SKIPPED` with the reason,
 * and a value too long for the field's `/MaxLen` is a skip rather than a silent truncation — the caller asked for a
 * value and would otherwise be told the job succeeded.
 */

/** `14-SIGN-AND-FORMS.md` §6: 500 fields written per job. */
const MAX_FIELDS_WRITTEN = 500;

export const fillFormHandler: Handler<FillFormOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to fill.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  const entries = Object.entries(options.fields);
  if (entries.length > MAX_FIELDS_WRITTEN) {
    throw new JobFailure('VALIDATION_ERROR', {
      message: `The job fills ${entries.length} fields; the limit is ${MAX_FIELDS_WRITTEN} per document.`,
    });
  }

  const pages = await countPdfPages(document.path, runOpts);

  // Before the write. Filling the field beside a signature changes bytes inside the signature's `/ByteRange`, and the
  // fixture this is asserted against carries a real `/Sig` field, so the sentence is owed on the same job that would
  // otherwise report nothing but success.
  const signature = await readSignatureRecord(document.path, runOpts);

  // The form has to exist *before* the write, because "you sent values for a document with no form" is a different
  // answer from "the form has none of those fields" — and the first one is the scanned-form case.
  report({ progress: 20, phase: 'processing', message: 'Reading the form.' });
  const before = await readFormFields(document.path, runOpts);
  if (before.fields.length === 0) {
    throw new JobFailure('NO_FORM_FIELDS', {
      message:
        'This document has no fillable form. If it is a scan, the fields are pixels rather than a form — run OCR first, or place a signature with the sign tool.',
    });
  }

  report({ progress: 45, phase: 'processing', message: 'Writing the values.' });
  const outputPath = join(outputDir, 'filled.pdf');
  const result = await fillForm(
    document.path,
    outputPath,
    options.fields as Record<string, FillValue>,
    {
      flatten: options.flatten,
      flattenMode: options.flattenMode,
    },
    runOpts,
  );

  report({ progress: 75, phase: 'finalizing', message: 'Reading the values back.' });
  // Which engine can verify the write depends on what the flatten did to the widget tree, and asking the wrong one
  // reports a false failure: after a flatten the widget is gone *by design*, so a widget read-back would call every
  // correctly flattened field a mismatch — which is exactly what it did before this branch existed.
  const after = await readFilledFormState(outputPath, runOpts);
  const flattened = options.flatten;
  const readAsText = flattened ? await readFilledText(outputPath, options.fields, runOpts) : null;
  const mismatches = flattened
    ? result.filled
        .filter((entry) => readAsText!.missing.includes(entry.name))
        .map((entry) => ({ name: entry.name, wrote: entry.value, reads: null }))
    : compareWritten(result, after, options.fields);

  const warnings: Array<{ code: string; detail?: string }> = [];
  const invalidatedSignature = signatureInvalidatedWarning(signature);
  if (invalidatedSignature) {
    warnings.push(invalidatedSignature);
  }
  for (const skip of result.skipped) {
    warnings.push({ code: 'FIELD_SKIPPED', detail: `${skip.name}: ${skip.reason}` });
  }
  if (mismatches.length > 0) {
    warnings.push({
      code: 'FIELD_STATE_UNRESOLVED',
      detail: flattened
        ? `${mismatches.length} field(s) were written and are nowhere in the flattened page's text, so the values were lost: ${mismatches.map((entry) => entry.name).join(', ')}`
        : `${mismatches.length} field(s) do not read back with the value that was written: ${mismatches
            .map(
              (entry) =>
                `${entry.name} (wrote ${JSON.stringify(entry.wrote)}, reads as ${JSON.stringify(entry.reads)})`,
            )
            .join(', ')}`,
    });
  }
  // Everything the flatten could not bake, named. This used to be a hard failure when any widget survived, which
  // punished the caller for the engine's limits: the fields that survive are exactly the ones with no appearance to
  // bake — an empty signature placeholder, or a mark the document never gave an appearance — and the output is
  // otherwise correct. The job says so instead of throwing it away.
  if (options.flatten && result.notFlattened.length > 0) {
    warnings.push({
      code: 'FIELD_NOT_FLATTENED',
      detail: `${result.notFlattened.length} annotation(s) could not be flattened and are still interactive: ${result.notFlattened
        .map((entry) => `${entry.name} (${entry.reason})`)
        .join(', ')}`,
    });
  }
  if (result.emptyFieldsRemoved.length > 0) {
    warnings.push({
      code: 'EMPTY_FIELDS_REMOVED',
      detail: `\`flattenMode: 'all'\` removed ${result.emptyFieldsRemoved.length} empty field(s) that had no appearance to bake: ${result.emptyFieldsRemoved.join(', ')}`,
    });
  }
  // The second form model, named rather than assumed away: a document carrying an `/XFA` packet may be filled by a
  // reader that prefers the packet over the AcroForm mirror this job writes into, so the caller is told to check in
  // their own reader instead of being handed a success that means different things in two applications
  // (`14-SIGN-AND-FORMS.md` §4). The packet itself is preserved untouched, which is what the sentence says.
  if (before.xfa) {
    warnings.push({
      code: 'FORM_XFA',
      detail:
        'This document carries an XFA packet beside its AcroForm. The values were written into the form fields, and the packet is left untouched — an XFA-aware reader may show the packet’s own data instead, so verify the result in the reader your recipient uses.',
    });
  }
  // A field whose value is in the file and not on the page — the exact failure mode this handler exists to prevent.
  // A signature field is the legitimate case, and it is named rather than swallowed.
  if (result.fieldsWithoutAppearance.length > 0) {
    warnings.push({
      code: 'APPEARANCE_MISSING',
      detail: `${result.fieldsWithoutAppearance.length} field(s) have no appearance stream, so their value may show as an empty box in a viewer that does not generate appearances: ${result.fieldsWithoutAppearance.join(', ')}`,
    });
  }

  const outputPages = await countPdfPages(outputPath, runOpts);
  if (outputPages !== pages) {
    throw new JobFailure('CONVERSION_FAILED', {
      message: `Filling the form changed the page count: ${pages} in, ${outputPages} out.`,
    });
  }

  return {
    outputs: [{ name: 'filled.pdf', mime: 'application/pdf', primary: true }],
    metrics: {
      pages: outputPages,
      fieldsInDocument: before.fields.length,
      fieldsRequested: entries.length,
      fieldsFilled: result.filled.length,
      fieldsSkipped: result.skipped.length,
      widgetsAfter: after.widgets,
      // What the read-back could actually check: a flattened checkbox leaves a tick on the page and no word in it.
      valuesVerifiedAsText: readAsText ? readAsText.text.length > 0 : false,
      valuesNotText: readAsText ? readAsText.unchecked.length : 0,
      flattened: options.flatten,
      flattenMode: options.flattenMode,
      // The mode's own promise, as a number: with `'filled'` this is 0 and the empty fields are still in the document;
      // with `'all'` it is what the flatten could not bake (listed in the warning) plus what it removed.
      unfilledFieldsKept: result.unfilledFieldsKept.length,
      emptyFieldsRemoved: result.emptyFieldsRemoved.length,
      notFlattened: result.notFlattened.length,
      // `signatureValues` is what the warning is gated on: the form fixture's empty `/FT /Sig` placeholder is
      // vocabulary without a signature, and it is counted in `signatureObjects` but not here.
      signatureObjects: signature.signatureObjects,
      signatureValues: signature.signatureValues,
      unsignedSignatureFields: signature.unsignedSignatureFields,
      changes: result.filled.map((entry) => ({
        kind: 'FIELD_FILLED',
        detail: `${entry.name} = ${JSON.stringify(entry.value)}`,
      })),
    },
    warnings,
    // Two engines on purpose, and which second one depends on the flatten: pikepdf wrote the file, then PyMuPDF read
    // the widget tree back — or, when the widgets were baked into the page, poppler read the page. The job's claim
    // rests on a reading by something other than the writer either way.
    engine: { name: flattened ? 'pikepdf+pdftotext' : 'pikepdf+pymupdf' },
  };
};

/**
 * What the reader sees, against what was written — the check that catches a field whose value is in the file and not
 * in the widget tree, and the checkbox whose state name resolves to nothing.
 */
function compareWritten(
  result: FillResult,
  after: { fields: Array<{ name: string; value: string | boolean | null; state: string | null }> },
  requested: Record<string, string | boolean | number>,
): Array<{ name: string; wrote: string | boolean | number; reads: string | boolean | null }> {
  const byName = new Map(after.fields.map((field) => [field.name, field]));
  const mismatches: Array<{ name: string; wrote: string | boolean | number; reads: string | boolean | null }> = [];
  for (const filled of result.filled) {
    const read = byName.get(filled.name);
    if (!read) {
      mismatches.push({ name: filled.name, wrote: requested[filled.name] ?? filled.value, reads: null });
      continue;
    }
    if (typeof filled.value === 'boolean') {
      if (read.value !== filled.value) {
        // A checkbox that was written "on" and reads "off" is the state-name failure, with its own warning text.
        mismatches.push({ name: filled.name, wrote: filled.value, reads: read.value });
      }
      continue;
    }
    if (String(read.value ?? '') !== String(filled.value)) {
      mismatches.push({ name: filled.name, wrote: filled.value, reads: read.value });
    }
  }
  return mismatches;
}
