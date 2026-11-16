import { JobFailure } from '@pdftools/errors';
import { runPdfToText } from './index';
import { parseJsonLine, runPythonScript, runPythonScriptStdin } from './python';
import type { RunOptions } from './run';

/**
 * AcroForm fields — `docs/14-SIGN-AND-FORMS.md`, the `extract-fields` and `fill-form` tools.
 *
 * One walk, two tools, and the walk is written against **widget annotations** rather than against the field tree's
 * top level. That is the decision everything else follows from. A form's fields live in `/AcroForm /Fields`, but that
 * array only holds the *top* of each field; the rectangle a user can click lives in the field's `/Kids` (or in the
 * field itself when it has a single widget), and the values and types a field's kids inherit are declared on their
 * parents. Walking `/Fields` therefore reports a radio group as one entry with no page and no rectangle, and misses
 * the inheritance entirely; walking every page's `/Annots` for `/Subtype /Widget` sees exactly the boxes that are on
 * the page, and resolves `/FT`, `/Ff`, `/V`, `/MaxLen` and `/Opt` up the `/Parent` chain the way a reader does.
 *
 * The measurements that shaped the fill path, all taken in the worker images before the handler was written:
 *
 *  - **`field.value` takes a PDF object, not a Python value.** `TextField.value = "Boni Pratama"` raises
 *    `TypeError: incompatible function arguments`; the value has to be built (`pikepdf.String(...)`,
 *    `pikepdf.Name('/Yes')`) because a field's `/V` is typed by the format, not by the caller.
 *  - **Appearance generation is gated on `/NeedAppearances`, and that gate is the whole "filled PDF that looks
 *    empty" story.** Measured on the fixture: with the flag absent, `generate_appearances_if_needed()` wrote
 *    **nothing** — every text and choice field still had no `/AP` — and `pdftotext` still read their values, because
 *    poppler renders a field's value from `/V` whether or not an appearance exists. So the file was right by one
 *    reader's account and would have been blank in any viewer that trusts the flag, which is what an absent
 *    `/NeedAppearances` means. Setting the flag first generates the appearances for real, and qpdf removes the flag
 *    itself afterwards. This is also what makes `flatten` work at all for those fields: there is nothing to bake
 *    without an appearance, so a flatten used to delete the widget and the value with it.
 *  - **`flatten_annotations()` bakes what has an appearance and leaves everything else untouched.** Measured: the
 *    button widgets (which had appearances) ended up as page content and gone from `/Annots`, while the text, choice
 *    and signature widgets — the three with no `/AP` — were still in `/Annots` afterwards, and `/AcroForm` was gone,
 *    which is why the first version of the handler failed the job with "flattening left 3 widget(s)".
 *  - **`flatten_annotations` has no per-annotation mode.** Its `mode` argument is `all`, `screen` or `print` — *how*
 *    much of each appearance to bake, not *which* annotations to touch. So the contract's `flattenMode` is honoured by
 *    moving the annotations that must survive out of the page, flattening, and putting them back. Restoring them
 *    correctly is subtle in a way that cost a defect: the first version replaced `/Annots` with the saved list, which
 *    **dropped the widgets qpdf had declined to flatten** — a value silently lost from a job that reported success.
 *  - **A checkbox state name must exist in `/AP /N`.** An appearance map is keyed by state name (`/Off`, `/Yes`), and
 *    a value that names a state the appearance map does not have renders as nothing at all. The trap that cost the
 *    most time in the probe: `pikepdf.Dictionary(**{'/Yes': stream})` writes the key **`//Yes`** — keyword names go in
 *    without the slash — which is a different name from `/Yes`, so `/AS /Yes` matched no appearance and the box stayed
 *    empty while every API said it was checked. It looked exactly like a product bug for two probe iterations.
 */

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'pushbutton' | 'signature' | 'unknown';

/** One clickable box, in PDF user space (points from the page's bottom-left corner). */
export interface FormFieldWidget {
  page: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export interface FormField {
  /** Fully qualified name — parents joined with `.`, which is the name a form-filling caller uses. */
  name: string;
  type: FormFieldType;
  /** `string` for text and choice, `boolean` for checkbox and radio, `null` when the field is empty. */
  value: string | boolean | null;
  /** The first widget's page, for the common case of a field with one box. */
  page: number | null;
  /** Every widget this field owns: a radio group has one per option. */
  rects: FormFieldWidget[];
  required: boolean;
  readOnly: boolean;
  maxLength: number | null;
  /** A choice field's `/Opt` entries, display text only. */
  options: string[];
  /** Whether the field carries an appearance (`/AP`) — a field without one has to be regenerated to be visible. */
  hasAppearance: boolean;
  /** The raw `/Ff` bit field, so a caller can see a flag this engine has no name for. */
  flags: number;
}

export interface FormReadResult {
  fields: FormField[];
  /** Widget annotations seen — a radio group is one field and several widgets. */
  widgets: number;
  /**
   * Whether the `/AcroForm` carries an `/XFA` packet — the second, competing form model.
   *
   * Read rather than inferred from the extension or the producer, because the packet's presence is the only thing that
   * says the two models disagree: a document with both a mirror and a packet may be filled by a reader that prefers the
   * packet, so `14-SIGN-AND-FORMS.md` §4 asks for `FORM_XFA` and this is where the fact comes from.
   */
  xfa: boolean;
  seconds: number;
}

/**
 * Read a document's form fields, or fail with `NO_FORM_FIELDS`.
 *
 * The failure is deliberate and typed rather than an empty list: a scanned form is the most common input to this tool,
 * and "no fields" with a 200 tells the user the form is empty when the truth is that the document has no form at all
 * (`14-SIGN-AND-FORMS.md` §3 asks for the suggestion to OCR it).
 */
export async function readFormFields(input: string, opts: Omit<RunOptions, 'engine'>): Promise<FormReadResult> {
  const result = await runPythonScriptStdin(READ_SCRIPT, { input, maxFields: MAX_FIELDS_READ }, opts);
  const parsed = parseJsonLine<FormReadResult & { error?: { message: string } }>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The document’s form fields could not be read.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return { ...parsed, seconds: Math.round(result.durationMs / 100) / 10 };
}

/** A caller's value, as it arrives from the contract's `fields` record. */
export type FillValue = string | boolean | number;

export interface FillResult {
  /** Fields the engine wrote a value into, in the order the caller supplied them. */
  filled: Array<{ name: string; type: FormFieldType; value: string | boolean }>;
  /** Values that could not be written, with the reason — `FIELD_SKIPPED` names both halves. */
  skipped: Array<{ name: string; reason: string }>;
  fieldsTotal: number;
  flattened: boolean;
  flattenMode: FillFormFlattenMode;
  /** Fields `flattenMode: 'filled'` kept interactive because the caller did not fill them — the mode's whole point. */
  unfilledFieldsKept: string[];
  /** Empty fields removed under `'all'`: nothing to draw, nothing to lose, and a form is not flattened while it lasts. */
  emptyFieldsRemoved: string[];
  /** Content the flatten could not bake, with the reason. Reported, because a silent leftover is a false promise. */
  notFlattened: Array<{ name: string; reason: string }>;
  /** Fields still without an appearance after generation — a signature field is the case that cannot ever have one. */
  fieldsWithoutAppearance: string[];
  seconds: number;
}

/**
 * What a flatten does with the fields the caller did not fill (`14-SIGN-AND-FORMS.md` §4).
 *
 * `'filled'` is the documented default from that section — "lock what I filled, leave the rest for the next person" —
 * and it is implemented by moving the unfilled widgets aside, flattening the page, and putting them back, because
 * qpdf flattens whole pages and has no per-annotation switch.
 */
export type FillFormFlattenMode = 'filled' | 'all';

/**
 * Write values into a document's fields, optionally flattening.
 *
 * The write is one pikepdf pass: values first, then the appearance generator (which is what makes a filled text field
 * visible), then — when flattening — the appearances baked into the page content. The handler verifies the result with
 * a **second engine**, because every claim in this function is about a file rather than about a return value.
 */
export async function fillForm(
  input: string,
  output: string,
  values: Record<string, FillValue>,
  options: { flatten: boolean; flattenMode: FillFormFlattenMode },
  opts: Omit<RunOptions, 'engine'>,
): Promise<FillResult> {
  const result = await runPythonScriptStdin(
    FILL_SCRIPT,
    {
      input,
      output,
      values,
      flatten: options.flatten,
      flattenMode: options.flattenMode,
      // `filled` keeps the fields the caller did not fill interactive; `all` flattens every widget. The engine only
      // flattens whole pages, so the difference is made by moving the survivors aside and back (see the script).
      keepUnfilledFields: options.flatten && options.flattenMode === 'filled',
    },
    opts,
  );
  const parsed = parseJsonLine<FillResult & { error?: { message: string } }>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The form values could not be written.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return { ...parsed, seconds: Math.round(result.durationMs / 100) / 10 };
}

export interface FilledFormText {
  text: string;
  /** Written string values that are nowhere in the page text — a flatten that lost them. */
  missing: string[];
  /** Values that cannot appear as text at all (a checkbox is a tick, not a word), so they are not checked here. */
  unchecked: string[];
}

/**
 * Read the page text with **poppler**, which is the only way to verify a *flattened* form.
 *
 * The widget read-back below cannot answer this case, and that is not a gap in it: once a field is flattened the
 * widget is gone by definition, so "the value is not in the widget tree" is what success looks like. A flatten bakes
 * the appearances into the page, and the page is what `pdftotext` reads — a third engine, neither the pikepdf that
 * wrote the file nor the PyMuPDF that reads the widgets back. The defect this exists to catch is the one that was
 * measured: a flatten that deleted the widgets and with them the values, reported as success.
 */
export async function readFilledText(
  path: string,
  values: Record<string, FillValue>,
  opts: Omit<RunOptions, 'engine'>,
): Promise<FilledFormText> {
  const result = await runPdfToText(['-layout', path, '-'], opts);
  if (result.code !== 0) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'pdftotext',
      message: 'The filled document could not be read back as text.',
      stderrTail: result.stderr.slice(-2000),
    });
  }
  const missing: string[] = [];
  const unchecked: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'boolean') {
      // A checkbox carries no text to find; its visibility is an appearance, which the golden suite asserts as ink.
      unchecked.push(name);
      continue;
    }
    if (!result.stdout.includes(String(value))) missing.push(name);
  }
  return { text: result.stdout, missing, unchecked };
}

export interface FilledFormState {
  fields: Array<{ name: string; type: string; value: string | boolean | null; state: string | null }>;
  /** Widgets left in the document. Zero is what `flatten` promises and the only way to see it. */
  widgets: number;
}

/**
 * Read a *filled* document's fields with **PyMuPDF**, not pikepdf.
 *
 * The write path is pikepdf, and a verification that asks the writer whether it wrote something is worth very little —
 * the checkbox measurement above is the argument: an engine can report `is_checked: True` for a file whose state name
 * no reader can resolve. PyMuPDF reads the widget tree from the other side (`widget.field_value`), so agreement
 * between the two is evidence rather than an echo. Heavy pool only: PyMuPDF is not in the light image.
 */
export async function readFilledFormState(path: string, opts: Omit<RunOptions, 'engine'>): Promise<FilledFormState> {
  const result = await runPythonScriptStdin(VERIFY_SCRIPT, { input: path }, opts);
  const parsed = parseJsonLine<FilledFormState & { error?: { message: string } }>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The filled document could not be read back.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return parsed;
}

/**
 * The field list as CSV, for the `format: 'csv'` branch.
 *
 * Written here rather than in the Python walk because the quoting rules are a decision about the *output*, not about
 * the document: a field name containing a comma, a quote or a newline is normal in a real form (`Last name, first`),
 * and a CSV that breaks on one is a spreadsheet the user cannot open. Values are included only when the caller asked
 * for them, so `includeValues: false` really is a schema export rather than a filtered view of one.
 */
export function formFieldsToCsv(fields: FormField[], includeValues: boolean): string {
  const columns = [
    'name',
    'type',
    'page',
    'required',
    'readOnly',
    'maxLength',
    'options',
    ...(includeValues ? ['value'] : []),
  ];
  const rows = fields.map((field) => {
    const cells: Array<string | number | boolean | null> = [
      field.name,
      field.type,
      field.page,
      field.required,
      field.readOnly,
      field.maxLength,
      field.options.join(' | '),
      ...(includeValues ? [field.value === null ? '' : String(field.value)] : []),
    ];
    return cells.map(csvCell).join(',');
  });
  return `${[columns.join(','), ...rows].join('\n')}\n`;
}

/** RFC 4180 quoting: a cell is quoted when it contains a comma, a quote or a line break, and quotes are doubled. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `14-SIGN-AND-FORMS.md` §6: 2 000 fields read. */
const MAX_FIELDS_READ = 2000;

const READ_SCRIPT = `import json, sys
import pikepdf
from pikepdf import Name

payload = json.load(sys.stdin)

# Bit positions from the PDF specification, not from a convenience library: 1 = read only, 2 = required,
# 15 = radio, 16 = pushbutton, 17 = combo, 18 = edit, 19 = sort, 21 = multiline, 26 = password, 24 = rich text.
FLAG_READ_ONLY = 1
FLAG_REQUIRED = 2
FLAG_RADIO = 1 << 15
FLAG_PUSHBUTTON = 1 << 16
FLAG_COMBO = 1 << 17


def resolve(node, key, depth=0):
    """A field's value as a reader sees it: the node's own key, or the nearest ancestor that declares one."""
    current = node
    hops = 0
    while current is not None and hops < depth + 32:
        if key in current:
            return current[key]
        current = current.get('/Parent')
        hops += 1
    return None


def qualified_name(node):
    parts = []
    current = node
    hops = 0
    while current is not None and hops < 32:
        name = current.get('/T')
        if name is not None:
            parts.append(str(name))
        current = current.get('/Parent')
        hops += 1
    return '.'.join(reversed(parts))


def field_type(node, flags):
    ft = resolve(node, '/FT')
    text = str(ft) if ft is not None else ''
    if text == '/Tx':
        return 'text'
    if text == '/Ch':
        return 'choice'
    if text == '/Sig':
        return 'signature'
    if text == '/Btn':
        if flags & FLAG_PUSHBUTTON:
            return 'pushbutton'
        if flags & FLAG_RADIO:
            return 'radio'
        return 'checkbox'
    return 'unknown'


def read_value(node, kind):
    raw = resolve(node, '/V')
    if raw is None:
        return None
    if kind in ('checkbox', 'radio'):
        # Any state but /Off is "on"; the state name itself is what a reader compares against /AP /N.
        return str(raw) != '/Off'
    return str(raw)


def options_of(node):
    raw = resolve(node, '/Opt')
    if raw is None:
        return []
    out = []
    for entry in raw:
        if isinstance(entry, pikepdf.Array) and len(entry) >= 2:
            # [export, display] — the display string is what a user sees and what a caller should send back.
            out.append(str(entry[1]))
        else:
            out.append(str(entry))
    return out


with pikepdf.Pdf.open(payload['input']) as pdf:
    widgets = 0
    # Keyed by name so a radio group (several widgets, one field) reports once, with all of its boxes.
    fields = {}
    for index, page in enumerate(pdf.pages, start=1):
        for annot in page.obj.get('/Annots', []):
            if annot.get('/Subtype') != Name('/Widget'):
                continue
            widgets += 1
            name = qualified_name(annot)
            if not name:
                # An unnamed widget is a widget the format cannot address; counted, reported, not invented.
                name = '(unnamed widget on page %d)' % index
            flags = int(resolve(annot, '/Ff') or 0)
            kind = field_type(annot, flags)
            rect = [float(v) for v in annot.get('/Rect', [0, 0, 0, 0])]
            entry = fields.get(name)
            if entry is None:
                entry = {
                    'name': name,
                    'type': kind,
                    'value': read_value(annot, kind),
                    'page': index,
                    'rects': [],
                    'required': bool(flags & FLAG_REQUIRED),
                    'readOnly': bool(flags & FLAG_READ_ONLY),
                    'maxLength': int(resolve(annot, '/MaxLen')) if resolve(annot, '/MaxLen') is not None else None,
                    'options': options_of(annot),
                    'hasAppearance': resolve(annot, '/AP') is not None,
                    'flags': flags,
                }
                fields[name] = entry
            entry['rects'].append({
                'page': index,
                'xPt': min(rect[0], rect[2]),
                'yPt': min(rect[1], rect[3]),
                'widthPt': abs(rect[2] - rect[0]),
                'heightPt': abs(rect[3] - rect[1]),
            })
    values = list(fields.values())
    if len(values) > payload['maxFields']:
        raise SystemExit('the document has %d fields; this tool reads at most %d' % (len(values), payload['maxFields']))
    acroform = pdf.Root.get('/AcroForm')
    xfa = acroform is not None and '/XFA' in acroform
    print(json.dumps({'fields': values, 'widgets': widgets, 'xfa': bool(xfa)}))`;

const FILL_SCRIPT = `import json, sys
import pikepdf
from pikepdf import Name, String

payload = json.load(sys.stdin)
FLAG_COMBO = 1 << 17


def resolve(node, key):
    current = node
    hops = 0
    while current is not None and hops < 32:
        if key in current:
            return current[key]
        current = current.get('/Parent')
        hops += 1
    return None


def qualified_name(node):
    parts = []
    current = node
    hops = 0
    while current is not None and hops < 32:
        name = current.get('/T')
        if name is not None:
            parts.append(str(name))
        current = current.get('/Parent')
        hops += 1
    return '.'.join(reversed(parts))


def kind_of(node):
    ft = resolve(node, '/FT')
    text = str(ft) if ft is not None else ''
    flags = int(resolve(node, '/Ff') or 0)
    if text == '/Btn':
        return 'pushbutton' if flags & (1 << 16) else ('radio' if flags & (1 << 15) else 'checkbox')
    return {'/Tx': 'text', '/Ch': 'choice', '/Sig': 'signature'}.get(text, 'unknown')


def annot_key(annot):
    """A stable identity for an annotation across accesses.

    pikepdf builds a **new Python wrapper** every time an element is read out of an array, so \`id(annot)\` compares
    wrappers rather than objects. Measured: the first version of the flatten used \`id()\` to remember which widgets
    to remove, and the empty signature widget was still in /Annots in the saved file while the script's own report
    said it had been removed. The object number is stable, and \`unparse()\` separates two annotations that would
    otherwise share the (0, 0) of a direct object.
    """
    try:
        number, generation = annot.objgen
        return '%d %d %s' % (number, generation, annot.unparse())
    except Exception:
        return 'inline %s' % annot.unparse()


def truthy(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on', 'checked')


def state_name(node):
    """The state to switch a box *on*: an appearance key that is not /Off, which is what a reader resolves."""
    names = []
    ap = resolve(node, '/AP')
    if ap is not None and '/N' in ap and isinstance(ap['/N'], pikepdf.Dictionary):
        names = [str(key) for key in ap['/N'].keys()]
    for candidate in names:
        if candidate != '/Off':
            return candidate
    # No appearance map to read: /Yes is the conventional name, and the handler reports the missing appearance.
    return '/Yes'


with pikepdf.Pdf.open(payload['input']) as pdf:
    widgets = []
    seen = {}
    for page in pdf.pages:
        for annot in page.obj.get('/Annots', []):
            if annot.get('/Subtype') == Name('/Widget'):
                name = qualified_name(annot)
                widgets.append((page, annot, name))
                seen.setdefault(name, []).append(annot)

    filled = []
    skipped = []
    for name, value in payload['values'].items():
        annots = seen.get(name)
        if not annots:
            skipped.append({'name': name, 'reason': 'no such field in the document'})
            continue
        kind = kind_of(annots[0])
        if kind in ('pushbutton', 'signature', 'unknown'):
            skipped.append({'name': name, 'reason': '%s fields cannot be filled' % kind})
            continue
        try:
            if kind in ('checkbox', 'radio'):
                target = state_name(annots[0])
                # Write /V and /AS together, in every widget of the field: /AS is what selects the appearance, and a
                # value without it is a field that reports "checked" and draws the empty box.
                for annot in annots:
                    annot['/V'] = Name(target if truthy(value) else '/Off')
                    annot['/AS'] = Name(target if truthy(value) else '/Off')
                filled.append({'name': name, 'type': kind, 'value': truthy(value)})
            else:
                text = str(value)
                max_len = resolve(annots[0], '/MaxLen')
                if max_len is not None and len(text) > int(max_len):
                    # Truncation is reported by the handler, not silently performed: the caller has to know the value
                    # they sent is not the value in the file.
                    skipped.append({
                        'name': name,
                        'reason': 'value is %d characters; the field allows %d' % (len(text), int(max_len)),
                    })
                    continue
                for annot in annots:
                    annot['/V'] = String(text)
                filled.append({'name': name, 'type': kind, 'value': text})
        except Exception as error:
            skipped.append({'name': name, 'reason': '%s: %s' % (type(error).__name__, error)})

    # ── Appearances, in two steps because one step does nothing on its own ────────────────────────────────────────
    #
    # \`generate_appearances_if_needed()\` is gated on \`/NeedAppearances\`. Measured on the form fixture: with the flag
    # absent it wrote *nothing*, and every text and choice field still had no \`/AP\` afterwards — the document was
    # claiming its appearances were current because that is what an absent flag means. Setting the flag first is what
    # a reader does when it opens such a file, and qpdf clears the flag itself once the appearances exist.
    #
    # The gated call was a live defect worth naming precisely: the value sat in \`/V\`, the widget drew nothing, and
    # \`flatten\` then had nothing to bake for that field, so it deleted the widget and the value with it. The output
    # was "successfully flattened" and blank where the name was.
    appearanceless = []
    if not pdf.Root.AcroForm.get('/NeedAppearances'):
        pdf.Root.AcroForm['/NeedAppearances'] = True
    pdf.acroform.generate_appearances_if_needed()
    if pdf.Root.AcroForm.get('/NeedAppearances'):
        # If the flag is still set, the file claims to need what now exists, which would send every reader off to
        # regenerate appearances that are already there.
        del pdf.Root.AcroForm['/NeedAppearances']

    # Which widgets are still without an appearance after generation — the fields a reader may show empty, and the
    # ones a flatten cannot bake. Reported rather than assumed away: a signature field can never have one.
    for page in pdf.pages:
        for annot in page.obj.get('/Annots', []):
            if annot.get('/Subtype') != Name('/Widget'):
                continue
            ap = resolve(annot, '/AP')
            if ap is None or '/N' not in ap:
                name_of_widget = qualified_name(annot)
                if name_of_widget not in appearanceless:
                    appearanceless.append(name_of_widget)

    # ── Flattening ───────────────────────────────────────────────────────────────────────────────────────────────
    #
    # qpdf flattens whole pages: it bakes every annotation that *has* an appearance and leaves the rest exactly where
    # they were. There is no per-annotation switch, so the modes are implemented by moving the annotations that must
    # survive out of the page, flattening, and putting them back:
    #
    #   'filled' — the fields the caller did not fill were already left alone by the write, so they are moved aside
    #              and restored: "lock what I filled, leave the rest for the next person".
    #   'all'    — every widget is a candidate; an empty one that cannot be baked (nothing to draw, nothing to lose)
    #              is removed, because a form the recipient can still type into is not flattened.
    filled_names = set(entry['name'] for entry in filled)
    unfilled_kept = []
    removed_empty = []
    not_flattened = []
    if payload['flatten']:
        move_aside = []
        for page in pdf.pages:
            original = list(page.obj.get('/Annots', []))
            # **Widgets** the caller did not fill, and only those. The first version of this kept every annotation
            # that was not a filled widget, which quietly exempted the document's other annotations (a highlight) from
            # the flatten the caller had just asked for — the opposite of what the option says. Content is content.
            keep = [
                a for a in original
                if a.get('/Subtype') == Name('/Widget') and qualified_name(a) not in filled_names
            ] if payload['keepUnfilledFields'] else []
            if keep:
                move_aside.append((page, keep))
                unfilled_kept.extend(
                    qualified_name(a) for a in keep if a.get('/Subtype') == Name('/Widget')
                )
            kept_keys = set(annot_key(a) for a in keep)
            page.obj['/Annots'] = pikepdf.Array(
                [a for a in original if annot_key(a) not in kept_keys]
            )
        pdf.flatten_annotations()
        restored = set()
        for page, keep in move_aside:
            survivors = list(page.obj.get('/Annots', []))
            page.obj['/Annots'] = pikepdf.Array(keep + survivors)
            for annot in keep:
                restored.add(annot_key(annot))

        for page in pdf.pages:
            remaining = list(page.obj.get('/Annots', []))
            for annot in remaining:
                key = annot_key(annot)
                if key in restored:
                    # Deliberately left interactive by \`flattenMode: 'filled'\`; the caller asked for this.
                    continue
                name_of_widget = qualified_name(annot)
                if annot.get('/Subtype') == Name('/Widget'):
                    value = resolve(annot, '/V')
                    if value is None:
                        # Nothing to draw and nothing to lose: an empty signature placeholder is the real case. It is
                        # the one leftover a flatten can remove without destroying anything.
                        page.obj['/Annots'] = pikepdf.Array(
                            [a for a in page.obj.get('/Annots', []) if annot_key(a) != key]
                        )
                        removed_empty.append(name_of_widget)
                        continue
                    not_flattened.append({
                        'name': name_of_widget,
                        'reason': 'the field keeps a value it has no appearance for; it stays editable',
                    })
                else:
                    not_flattened.append({
                        'name': name_of_widget or str(annot.get('/Subtype')) or '/Annot',
                        'reason': 'the annotation has no appearance stream, so there is nothing to bake',
                    })

    pdf.save(payload['output'])
    print(json.dumps({
        'filled': filled,
        'skipped': skipped,
        'fieldsTotal': len(seen),
        'flattened': bool(payload['flatten']),
        'flattenMode': payload['flattenMode'],
        'unfilledFieldsKept': sorted(set(unfilled_kept)),
        'emptyFieldsRemoved': sorted(set(removed_empty)),
        'notFlattened': not_flattened,
        'fieldsWithoutAppearance': appearanceless,
    }))`;

const VERIFY_SCRIPT = `import json, sys
import pymupdf

payload = json.load(sys.stdin)
doc = pymupdf.open(payload['input'])
fields = []
widgets = 0
for page in doc:
    for widget in page.widgets():
        widgets += 1
        value = widget.field_value
        if widget.field_type_string in ('CheckBox', 'RadioButton'):
            fields.append({
                'name': widget.field_name,
                'type': widget.field_type_string,
                'value': str(value) != 'Off',
                'state': str(value),
            })
        else:
            fields.append({
                'name': widget.field_name,
                'type': widget.field_type_string,
                'value': None if value in (None, '') else str(value),
                'state': None,
            })
# Deduplicated by name: a radio group is several widgets and one field, and the caller wrote one value.
unique = {}
for field in fields:
    unique.setdefault(field['name'], field)
print(json.dumps({'fields': list(unique.values()), 'widgets': widgets}))`;

/**
 * What a document *has*, asked before a rewrite takes it away — `04-COMPRESS.md` §6.
 *
 * The counting half of the walk above, without the field-by-field read: `compress` needs to know whether there is a
 * form to lose, not what is in it, and `runPythonScript` + one page walk is the cheapest way to answer that with the
 * engine family that wrote the file. Measured on `form-five-fields-a4.pdf` through Ghostscript's `pdfwrite`: **six**
 * widgets and the `/AcroForm` dictionary leave the document, while a `/Highlight` on the same page stays — so
 * "annotations are preserved" and "form fields are not flattened" were both wrong about the same rewrite, and the job
 * said nothing at all (defect 144).
 */
export interface FormPresence {
  /** Field widgets drawn on a page: the boxes a user can click and type in. */
  widgets: number;
  /** Every annotation on every page, of any subtype — the population the widgets are a subset of. */
  annotations: number;
  /** Whether the catalog carries an `/AcroForm`, which a form with no widget on a page still does. */
  acroForm: boolean;
}

export async function readFormPresence(input: string, opts: Omit<RunOptions, 'engine'>): Promise<FormPresence> {
  const result = await runPythonScript(
    `import json, sys
import pikepdf

payload = json.loads(sys.argv[sys.argv.index('--json') + 1])
with pikepdf.Pdf.open(payload['input']) as pdf:
    widgets = 0
    annotations = 0
    for page in pdf.pages:
        for obj in (page.get('/Annots') or []):
            annotations += 1
            if str(obj.get('/Subtype')) == '/Widget':
                widgets += 1
    print(json.dumps({
        'widgets': widgets,
        'annotations': annotations,
        'acroForm': '/AcroForm' in pdf.Root,
    }))`,
    { input },
    opts,
  );
  const parsed = parseJsonLine<FormPresence>(result.stdout);
  if (!parsed) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'python',
      message: 'The document’s annotations could not be read.',
      stderrTail: result.stdout + result.stderr,
    });
  }
  return parsed;
}
