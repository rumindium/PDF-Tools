import { join } from 'node:path';
import type { ExtractFieldsOptions } from '@pdftools/contracts/tools';
import { type FormField, formFieldsToCsv, readFormFields } from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `extract-fields` — `docs/14-SIGN-AND-FORMS.md` §2, and the first tool in this build whose output is not a document.
 *
 * Three decisions, and each one is a place where the obvious implementation tells the user something untrue:
 *
 *  1. **A document with no form fails with `NO_FORM_FIELDS`, not with an empty JSON file.** The most common input here
 *     is a *scanned* form, and a 200 with `[]` says "your form has no fields" when the truth is "this PDF has no form
 *     at all, run OCR first" — which is the sentence the code exists to say, and the reason the doc gives it its own
 *     error rather than folding it into `VALIDATION_ERROR`.
 *  2. **The output is a real file, downloaded like any other.** `GET /jobs/:id/result?part=primary` returns
 *     `fields.json` or `fields.csv`; the field list is *also* in `metrics`, but a caller who wants the data should not
 *     have to parse a job report to get it, and every other tool in this build hands back a file.
 *  3. **`includeValues: false` omits the value column rather than blanking it.** A schema export and a filtered export
 *     look identical in JSON (`"value": null` is both "empty field" and "not asked for"), so the CSV branch drops the
 *     column and the JSON branch drops the key — the difference has to be visible in the shape of the answer.
 */

/** `14-SIGN-AND-FORMS.md` §6: 2 000 fields read; the handler reports the count it found either way. */
export const extractFields: Handler<ExtractFieldsOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;

  const document = files.find((file) => file.kind !== 'attachment');
  if (!document) {
    throw new JobFailure('INVALID_FILE', { message: 'The job has no document to read fields from.' });
  }

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  report({ progress: 30, phase: 'processing', message: 'Reading the form fields.' });
  const { fields, widgets, xfa, seconds } = await readFormFields(document.path, runOpts);

  if (fields.length === 0) {
    throw new JobFailure('NO_FORM_FIELDS', {
      message:
        'This document has no fillable form. If it is a scan, the fields are pixels rather than a form — run OCR first, or place a signature with the sign tool.',
    });
  }

  report({ progress: 80, phase: 'finalizing' });
  const name = options.format === 'csv' ? 'fields.csv' : 'fields.json';
  const outputPath = join(outputDir, name);
  await Bun.write(
    outputPath,
    options.format === 'csv'
      ? formFieldsToCsv(fields, options.includeValues)
      : JSON.stringify(shapeJson(fields, options.includeValues), null, 2),
  );

  // A form with a kind this build does not name is worth saying out loud: a caller reading the output sees
  // `"type": "unknown"` and would otherwise assume the tool failed to classify a field it never looked at.
  const warnings: Array<{ code: string; detail?: string }> = [];
  const unknown = fields.filter((field) => field.type === 'unknown');
  if (unknown.length > 0) {
    warnings.push({
      code: 'FIELD_TYPE_UNKNOWN',
      detail: `${unknown.length} field(s) carry a type this build does not name: ${unknown.map((field) => field.name).join(', ')}`,
    });
  }
  const withoutAppearance = fields.filter((field) => !field.hasAppearance);
  if (withoutAppearance.length > 0) {
    warnings.push({
      code: 'APPEARANCE_MISSING',
      detail: `${withoutAppearance.length} field(s) have no appearance stream; a reader that does not regenerate them shows the boxes empty. Filling the form with \`fill-form\` generates them.`,
    });
  }
  // The list below is the AcroForm mirror, and an XFA packet is a second answer to the same question. Reported here
  // for the same reason `fill-form` reports it: a caller who reads six fields from a document whose reader shows a
  // different form deserves to know which model they just read (`14-SIGN-AND-FORMS.md` §4).
  if (xfa) {
    warnings.push({
      code: 'FORM_XFA',
      detail:
        'This document carries an XFA packet beside its AcroForm. The fields below are the form dictionary; an XFA-aware reader may show the packet’s own data instead.',
    });
  }

  return {
    outputs: [{ name, mime: options.format === 'csv' ? 'text/csv' : 'application/json', primary: true }],
    metrics: {
      seconds,
      fields: fields.length,
      widgets,
      pages: new Set(fields.flatMap((field) => field.rects.map((rect) => rect.page))).size,
      byType: countByType(fields),
      xfa,
      includeValues: options.includeValues,
      format: options.format,
    },
    warnings,
    engine: { name: 'pikepdf' },
  };
};

/** The field list as the JSON output wants it, with `value` omitted entirely when values were not requested. */
function shapeJson(fields: FormField[], includeValues: boolean) {
  return {
    fields: fields.map((field) => ({
      name: field.name,
      type: field.type,
      ...(includeValues ? { value: field.value } : {}),
      page: field.page,
      // `rects` rather than a single `rect`: a radio group is one field with one box per option, and reporting only
      // the first would hide where the other two are.
      rects: field.rects,
      required: field.required,
      readOnly: field.readOnly,
      maxLength: field.maxLength,
      ...(field.options.length > 0 ? { options: field.options } : {}),
      hasAppearance: field.hasAppearance,
    })),
  };
}

function countByType(fields: FormField[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const field of fields) {
    counts[field.type] = (counts[field.type] ?? 0) + 1;
  }
  return counts;
}
