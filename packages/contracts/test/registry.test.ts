import { describe, expect, test } from 'bun:test';
// The plan table, imported directly: `src/tools/index.ts` deliberately re-exports only the tool surface, and a plan
// ceiling is what the routing rule has to fit inside rather than part of the routing rule itself.
import { PLANS } from '../src/plans';
import {
  CATALOG_VERSION,
  SECRET_PLACEHOLDER,
  TOOLS,
  effectiveQueue,
  effectiveTimeoutSeconds,
  getTool,
  largestInputBatch,
  optionKeys,
  optionSchema,
  redactSecrets,
  requireTool,
  secretKeysFor as secretKeys,
  secretViolations,
  toolAllowed,
  validateOptions,
} from '../src/tools/index';

/**
 * Registry contract tests (`docs/0-TESTING.md` §2).
 *
 * These assert the properties the whole system leans on, not individual values: the registry is what the API
 * validates with, what a worker re-validates with, and what the UI renders its forms from. A broken invariant here
 * shows up as three unrelated-looking bugs in three components.
 */

describe('catalog invariants', () => {
  test('every tool id is unique and kebab-case', () => {
    const ids = TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('the catalog version is a positive integer', () => {
    expect(Number.isInteger(CATALOG_VERSION)).toBe(true);
    expect(CATALOG_VERSION).toBeGreaterThan(0);
  });

  test('every tool declares a queue, limits, and at least one accepted type', () => {
    for (const tool of TOOLS) {
      expect(['light', 'office', 'heavy', 'ocr']).toContain(tool.queue);
      expect(tool.input.accepts.length).toBeGreaterThan(0);
      expect(tool.input.maxFiles).toBeGreaterThanOrEqual(1);
      expect(tool.limits.timeoutSeconds).toBeGreaterThan(0);
      expect(tool.limits.memoryMb).toBeGreaterThan(0);
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(0);
    }
  });

  test('every tool exposes its option keys, refined schemas included', () => {
    // `.shape` is undefined for schemas wrapped by `.refine()`, so this must go through `optionKeys()`; asserting
    // on `.shape` directly would crash on four tools rather than report a problem.
    for (const tool of TOOLS) {
      expect(optionKeys(tool).length).toBeGreaterThan(0);
    }
    expect(optionKeys(requireTool('merge'))).toEqual(expect.arrayContaining(['order', 'bookmarks']));
    expect(optionKeys(requireTool('reorder-pages'))).toEqual(expect.arrayContaining(['order', 'duplicate', 'reverse']));
    // ...and nothing else: `insertPages` was removed in pass 5 (defect 138) because this tool's input is one file, so
    // an insertion naming a second document could never be honoured. `toEqual(arrayContaining(...))` alone would not
    // notice it coming back, and this is the assertion that keeps the *removal* from being undone by a merge.
    expect(optionKeys(requireTool('reorder-pages'))).not.toContain('insertPages');
  });

  test('the optionsUi and the schema describe the same keys', () => {
    // This is the invariant that keeps the form and the validator from drifting: a control for a key the schema
    // does not accept would render happily and then fail on submit, and a schema key with no control is an option
    // no user can ever set.
    for (const tool of TOOLS) {
      const keys = optionKeys(tool);
      const uiKeys = tool.optionsUi.map((field) => field.key);
      expect(uiKeys.slice().sort()).toEqual(keys.slice().sort());
      for (const field of tool.optionsUi) {
        // Both choice controls emit `choices[].value` and nothing else, so a choice control with no choices is an
        // option no user can set — and the segmented one has to have options to be segmented between.
        if (field.control === 'select' || field.control === 'segmented') {
          expect(field.choices?.length ?? 0).toBeGreaterThan(0);
        }
        // `removes` names a sibling control the panel reads the direction from, so the sibling has to exist: a typo'd
        // key would silently leave every page selection reading "keeps", which is the one thing this metadata is for.
        if (field.removes && field.removes !== true) {
          expect(uiKeys).toContain(field.removes.key);
        }
      }
    }
  });

  test('a comparison table describes the choices it is attached to', () => {
    // The table is presentational, so nothing else in the build would notice it going wrong: a table describing three
    // profiles beside a select offering four renders happily, and a reader of `09-PDF-A.md` §2 — which states that this
    // comparison is shown in the UI — would be reading a page that describes a control that does not exist. Which is
    // the defect this test was written for, in the other direction: the document claimed it and the UI had it not.
    const declaring = TOOLS.filter((tool) => tool.optionsUi.some((field) => field.comparison));
    expect(declaring.map((tool) => tool.id)).toContain('pdf-to-pdfa');
    for (const tool of TOOLS) {
      for (const field of tool.optionsUi) {
        if (!field.comparison) continue;
        expect(field.comparison.rows.length).toBe(field.choices?.length ?? 0);
        for (const row of field.comparison.rows) expect(row.length).toBe(field.comparison.columns.length);
      }
    }
  });

  test('every control sends a value its own schema accepts', () => {
    // The other half of the invariant above, and the half that was missing: the keys can match while the *kind* does
    // not. `encrypt`'s `permissions` was declared `control: 'text'` for an object schema, so the panel rendered an
    // empty text box, submitted what was typed as a string, and the API answered `Expected object, received string` —
    // on a job the form itself had built. Nothing in this repository could see it: `optionKeys` matched, the schema was
    // valid, and the golden suite posts `{ copy: false }` by hand. The same shape of defect had already been fixed
    // once, for `split`'s nested page groups (`./types.ts`, `range-groups`), which is why this is a probe rather than a
    // promise to be careful.
    //
    // The probe asks the schema, not a table: for each control, the values it is capable of producing are offered to
    // the schema at that key, and **one** of them has to parse. Several samples per control on purpose — a `text`
    // control legitimately fills a hex colour, a font name, a date and a page range, and a probe with a single sample
    // would fail on schemas that are perfectly well served. A string is not among the samples that an object schema
    // accepts, which is the entire assertion.
    const samplesFor = (field: OptionsUiField): unknown[] | null => {
      switch (field.control) {
        // A text box can fill a page range, a hex colour, a font name, a date, an address, an ISO language code or a
        // metadata store name. Several samples rather than one because the field's *own* control is right for all of
        // them, and a single sample would fail on schemas that are perfectly well served by a text box.
        case 'text':
          return ['x', 'eng', 'xmp', 'docinfo', '#9aa0a6', 'a@b.co', '2024-01-01', 'Helvetica', 'A4', '1-3'];
        // Ten characters and four classes: over every floor and policy in `password-strength.ts`, so a failure here
        // means the *kind* is wrong rather than the strength.
        case 'password':
          return ['Abcd-1234!'];
        // From the field's own bounds where it declares them: `dpi` is `min(36).max(300)`, and a probe sampling 1
        // would be measuring this test's arithmetic instead of the control.
        case 'number':
          return [field.min ?? 1, field.max ?? 8, 0.5];
        case 'toggle':
          return [true];
        case 'pages':
        // The boxes produce the same flat `string[]` the text field does — that is the point of it being a *presentation*
        // of `pages` rather than a value of its own — so it is probed with the same samples.
        case 'page-rows':
          return [['1-3'], []];
        // And the segmented choice emits one of its own `choices`, so the probe offers the schema exactly those instead
        // of a sample this test invented.
        case 'segmented':
          return (field.choices ?? []).map((choice) => choice.value);
        case 'range-groups':
          return [[['1-3']], []];
        // One board writes **three** keys (`order`, `duplicate`, `reverse`), so the probe offers what each of them is: a
        // page list for the two arrays and a boolean for the switch. The board is what produces them, and the samples
        // are the values it can produce rather than a guess about the control.
        case 'page-order':
          return [[2, 1], true];
        // One board writes **two** keys here (`angle` and `perPage`), and they are different shapes on purpose: an angle
        // for the whole document and a map of page → angle for a mixed one. The third key of that tool, `pages`, is an
        // ordinary field, so it is probed above.
        case 'page-turn':
          return [90, { '2': 180 }];
        // The crop board writes `box` — four edge insets and every one of them required, so the sample carries all
        // four: an object with a missing edge is a 422, and a probe that offered `{ top: 1 }` would be measuring the
        // schema's requirements instead of the control's kind. The board writes exactly this shape, in whichever unit
        // the sibling `units` select says.
        case 'crop-box':
          return [
            { top: 20, right: 20, bottom: 20, left: 20 },
            { top: 5, right: 0, bottom: 5, left: 0 },
          ];
        // One board writes **two** keys here as well (`perSheet` and `orientation`), and they are different shapes on
        // purpose: a count the schema enumerates, and one of two words. The tool's other two options are ordinary fields
        // and are probed above — which is also the assertion that this control kind did not swallow them.
        case 'sheet-grid':
          return [2, 4, 6, 9, 16, 'portrait', 'landscape'];
        // The third of the sheet's options, and the same shape as any other enumerated word: the probe is every stock the
        // schema accepts, so a board that wrote a *label* instead of a value would fail here rather than in the browser.
        case 'sheet-paper':
          return ['source', 'a4', 'a3', 'letter', 'legal'];
        case 'file-order':
          return [[], ['f']];
        // Both of these store the id of an upload, so the sample is a uuid rather than an arbitrary string.
        case 'upload':
        case 'signature-pad':
          return ['00000000-0000-4000-8000-000000000000'];
        // `json`, `placement` and `select` are deliberately absent: a JSON control is *supposed* to accept anything
        // the schema might want, a placement editor produces the object its own schema describes, and `select` is
        // covered by its `choices` above — the value it emits comes from the catalog rather than from the keyboard.
        default:
          return null;
      }
    };
    const misfits: Record<string, string[]> = {};
    for (const tool of TOOLS) {
      const schemas = optionSchema(tool);
      for (const field of tool.optionsUi) {
        const samples = samplesFor(field);
        if (!samples) continue;
        const schema = schemas[field.key];
        if (!schema) {
          misfits[tool.id] = [...(misfits[tool.id] ?? []), `${field.key}: no schema`];
          continue;
        }
        const accepts = samples.some((sample) => schema.safeParse(sample).success);
        if (!accepts) misfits[tool.id] = [...(misfits[tool.id] ?? []), `${field.key} (${field.control})`];
      }
    }
    expect(misfits).toEqual({});
  });

  test('every tool, enabled or not, offers a control for every option', () => {
    // The invariant above covers the shape; this covers the intent — no tool may declare an option that nobody
    // can set. It applies to disabled tools too, so a tool cannot ship with a half-built form: the registry is
    // the contract, and a future `enabled: true` must not be the moment the gap is discovered.
    const gaps: Record<string, string[]> = {};
    for (const tool of TOOLS) {
      const uiKeys = tool.optionsUi.map((field) => field.key);
      const missing = optionKeys(tool).filter((key) => !uiKeys.includes(key));
      if (missing.length > 0) gaps[tool.id] = missing.sort();
    }
    expect(gaps).toEqual({});
  });

  test('every option the UI renders as a password is declared a secret, and vice versa', () => {
    // Two lists describe the same fact — "this value must never be written down" — so they must not be able to
    // drift. The `password` control is what the user sees; `secrets` is what the API, the queue and the worker act
    // on. A control with no declaration stores a password in `jobs.options`; a declaration with no control redacts
    // a key the user cannot set, which is a silent hole in the audit that counts on the declaration being real.
    const undeclared: Record<string, string[]> = {};
    const unbacked: Record<string, string[]> = {};
    for (const tool of TOOLS) {
      const controls = tool.optionsUi.filter((field) => field.control === 'password').map((field) => field.key);
      const declared = [...(tool.secrets ?? [])];
      const missing = controls.filter((key) => !declared.includes(key));
      if (missing.length > 0) undeclared[tool.id] = missing.sort();
      const extra = declared.filter((key) => !optionKeys(tool).includes(key));
      if (extra.length > 0) unbacked[tool.id] = extra.sort();
    }
    expect(undeclared).toEqual({});
    expect(unbacked).toEqual({});
  });

  test('every declared secret sits at the top level of its schema, and is a string', () => {
    // `redactSecrets` is a shallow operation, and the audit asks "is the value at this key the placeholder?". Both
    // are only true for a top-level string, so a nested or non-string declaration is a bug in the declaration
    // rather than a limitation to document.
    for (const tool of TOOLS) {
      for (const key of tool.secrets ?? []) {
        expect(optionKeys(tool)).toContain(key);
        expect(key).not.toContain('.');
        expect(key).not.toContain('[');
      }
    }
    expect(requireTool('encrypt').secrets).toEqual(['userPassword', 'ownerPassword']);
    expect(requireTool('unlock').secrets).toEqual(['password']);
    expect(requireTool('merge').secrets).toBeUndefined();
  });

  test('the passwords a tool chooses are a subset of its secrets, and `unlock` chooses none', () => {
    // `setsPasswords` decides which fields the strength policy judges (`password-strength.ts`), so it has a second
    // job: it must not name a key that is not a secret, or the policy would read a value this build is willing to
    // write down. The pair is asserted per tool rather than as one flat list, because the interesting failures are
    // per tool — a password field added to `encrypt` and forgotten in `setsPasswords` is a field with no policy.
    for (const tool of TOOLS) {
      for (const key of tool.setsPasswords ?? []) {
        expect(secretKeys(tool)).toContain(key);
        expect(tool.optionsUi.some((field) => field.key === key && field.control === 'password')).toBe(true);
      }
    }

    expect(requireTool('encrypt').setsPasswords).toEqual(['userPassword', 'ownerPassword']);
    expect(requireTool('restrict').setsPasswords).toEqual(['ownerPassword']);
    // The one that matters. `unlock` takes a password that already exists on somebody else's document: it declares
    // the key a secret (never write it down) and must never declare it policy-governed (never judge it). Refusing to
    // open a file because its owner chose `1234` punishes the person holding the document, and this assertion is what
    // keeps that distinction from being lost the next time a password field is added here.
    expect(requireTool('unlock').secrets).toEqual(['password']);
    expect(requireTool('unlock').setsPasswords).toBeUndefined();
    // And the inverse for a tool with no passwords at all: an empty declaration is a licence for the policy to run
    // over nothing, which reads in the catalogue as "this tool's passwords are judged".
    expect(requireTool('merge').setsPasswords).toBeUndefined();
  });

  test('a tool’s own rate limit undercuts the shared one, or it is decoration', () => {
    // `apps/api` charges the tool's bucket in addition to the per-identity limit every request pays
    // (`apps/api/src/modules/jobs.ts`), whose shipped default is `RATE_LIMIT_PER_MINUTE=60`. A tool limit at or above
    // that changes nothing while reading in the registry as protection — the failure mode this whole file exists to
    // catch. The number is asserted as *below the documented default* rather than against an import, because the
    // default lives in `packages/config` and the registry must not depend on the environment to describe a tool.
    const SHARED_DEFAULT_PER_MINUTE = 60;
    const limited = TOOLS.filter((tool) => tool.rateLimit);
    expect(limited.length).toBeGreaterThan(0);
    for (const tool of limited) {
      expect(tool.rateLimit!.perMinute).toBeGreaterThan(0);
      expect(tool.rateLimit!.perMinute).toBeLessThan(SHARED_DEFAULT_PER_MINUTE);
      expect(Number.isInteger(tool.rateLimit!.perMinute)).toBe(true);
    }
    // `unlock` is the only tool that takes a guess at a password that is not the caller's; it is the reason the field
    // exists at all, and naming it here means removing the limit is a failing test rather than a quieter product.
    expect(requireTool('unlock').rateLimit).toEqual({ perMinute: 6 });
  });

  test('redacting the options of every tool with a secret still validates', () => {
    // The redacted options are what gets persisted, and the worker re-validates what it is handed. If a placeholder
    // were shorter than a `min(6)` password, a redacted record would be a record no schema accepts — and the way
    // that fails is a `VALIDATION_ERROR` on a job that was completely valid when it was submitted.
    const samples: Record<string, Record<string, unknown>> = {
      encrypt: { userPassword: 'open-sesame', ownerPassword: 'owner-secret' },
      restrict: { ownerPassword: 'owner-secret' },
      unlock: { password: 'open-sesame' },
    };
    for (const [id, options] of Object.entries(samples)) {
      const def = requireTool(id);
      const redacted = redactSecrets(def, options);
      expect(secretViolations(def, redacted)).toEqual([]);
      const result = validateOptions(id, redacted);
      if (!result.ok) throw new Error(`${id}: ${JSON.stringify(result.issues)}`);
      // The placeholder must not survive as a *usable* value: merging nothing leaves it in place, which is exactly
      // why the worker refuses to run without the stash rather than falling back to the payload.
      expect(Object.values(redacted)).toContain(SECRET_PLACEHOLDER);
    }
  });

  test('every escalation target is a heavier pool than the tool’s own', () => {
    for (const tool of TOOLS) {
      if (!tool.escalate) continue;
      expect(tool.escalate.queue).toBe('heavy');
    }
  });

  test('an escalated job gets a longer budget than it would have had', () => {
    // Escalation means the job is bigger than the pool it was submitted to. A `timeoutSeconds` that is smaller
    // than the tool's own budget would hand the heavy pool less time than the light pool had — a configuration
    // that can only ever produce timeouts, so it is rejected here rather than discovered in production.
    for (const tool of TOOLS) {
      if (!tool.escalate) continue;
      expect(tool.escalate.timeoutSeconds).toBeGreaterThan(tool.limits.timeoutSeconds);
      expect(effectiveTimeoutSeconds(tool, tool.escalate.queue)).toBe(tool.escalate.timeoutSeconds);
      expect(effectiveTimeoutSeconds(tool, tool.queue)).toBe(tool.limits.timeoutSeconds);
    }
    expect(requireTool('merge').escalate?.timeoutSeconds).toBe(420);
  });
});

describe('lookup helpers', () => {
  test('getTool returns undefined for an unknown id and requireTool throws', () => {
    expect(getTool('not-a-tool')).toBeUndefined();
    expect(() => requireTool('not-a-tool')).toThrow();
    expect(requireTool('merge').id).toBe('merge');
  });
});

describe('effectiveQueue', () => {
  const base = { queue: 'light' as const, escalate: { queue: 'heavy' as const, abovePages: 500, aboveBytes: 1000 } };

  test('stays in its own pool below every threshold', () => {
    expect(effectiveQueue(base, { pages: 10, bytes: 10 })).toBe('light');
  });

  test('escalates on pages, bytes, or both', () => {
    expect(effectiveQueue(base, { pages: 501 })).toBe('heavy');
    expect(effectiveQueue(base, { bytes: 1001 })).toBe('heavy');
    expect(effectiveQueue(base, { pages: 501, bytes: 1001 })).toBe('heavy');
  });

  test('a tool without escalation rules never moves pools', () => {
    expect(effectiveQueue({ queue: 'ocr' }, { pages: 100_000, bytes: 10 ** 12 })).toBe('ocr');
  });

  test('the thresholds the documents state are the ones the catalog routes on', () => {
    // The synthetic definition above cannot see a catalog edit, and the catalog is where the numbers live: both
    // routing points (the API on the *claimed* sizes, the worker on the sizes that turned out to be true) call this
    // one function, so a drifting threshold here moves a job's pool and its time budget together.
    //
    // `04-COMPRESS.md` §6: "above 300 pages or 100 MB". The boundary is **strict**, and that is the half worth
    // pinning: a job of exactly 300 pages stays on the light pool, which is the reading a document saying "above"
    // asks for, and the end-to-end case in the heavy golden pool runs 320 pages through this same rule.
    const compress = requireTool('compress');
    expect(compress.escalate).toMatchObject({
      queue: 'heavy',
      abovePages: 300,
      aboveBytes: 100 * 1024 * 1024,
      timeoutSeconds: 420,
    });
    expect(effectiveQueue(compress, { pages: 300, bytes: 100 * 1024 * 1024 })).toBe('light');
    expect(effectiveQueue(compress, { pages: 301 })).toBe('heavy');
    expect(effectiveQueue(compress, { bytes: 100 * 1024 * 1024 + 1 })).toBe('heavy');

    // `merge` escalates on a file count, which is a third kind of claim; keeping it here means a new tool has one
    // place to copy from that covers all three.
    expect(requireTool('merge').escalate).toMatchObject({ queue: 'heavy', abovePages: 1000, aboveFiles: 20 });
  });

  test('every byte threshold is reachable by at least one plan, and not by the smallest ones', () => {
    // A threshold nothing can cross is not a rule, and the byte axis has two ways to end up that way — both of them
    // measurements rather than guesses:
    //
    //   · the **plan table**: Free is 100 MB per file, which is *exactly* `compress`'s `aboveBytes`, and the comparison
    //     is strict, so no Free job can ever escalate on size. Anonymous is 50 MB per file, further away still.
    //   · the **deployment**: `MAX_FILE_SIZE_MB` (50 MB by default, `packages/config/src/env.ts`) caps every upload
    //     regardless of plan, so on a default stack the boundary cannot be crossed by anybody — which is why the golden
    //     case for it runs in a CI job that raises the ceiling (`0-CICD.md` §3).
    //
    // Neither is a bug in the catalog, and the case that exercises the rule is the test of the rule. What this pins is
    // the part a future edit could quietly break: if Pro ever dropped to a 100 MB file ceiling, the golden case would
    // start failing with `FILE_TOO_LARGE` and would look like a stack problem, and the cause would be a number in this
    // table. So the table is asked directly: does *some* plan hold a file that crosses every byte threshold?
    const byteThresholds = TOOLS.map((tool) => tool.escalate?.aboveBytes).filter(
      (value): value is number => value != null,
    );
    for (const threshold of byteThresholds) {
      const capable = Object.values(PLANS).filter((plan) => plan.maxFileMb * 1024 * 1024 > threshold);
      expect(capable.map((plan) => plan.id)).not.toEqual([]);
      // And the other direction, so the assertion above cannot pass by accident of a table that grew: the smallest
      // plans are the ones that cannot, which is what `04-COMPRESS.md` §6's "100 MB" means to a Free visitor.
      expect(PLANS.free.maxFileMb * 1024 * 1024).toBeLessThanOrEqual(threshold);
    }
  });
});

describe('plan gating', () => {
  test('a wildcard entitlement still cannot open a plan-gated tool', () => {
    // The tool's own `plans` gate exists to survive a mis-seeded entitlement; a wildcard must not override it.
    const gated = { id: 'sign', plans: ['pro', 'business'] as const };
    expect(toolAllowed(gated, ['*'], 'free')).toBe(false);
    expect(toolAllowed(gated, ['*'], 'pro')).toBe(true);
  });

  test('an explicit tool list is required unless it is a wildcard', () => {
    const open = { id: 'merge' };
    expect(toolAllowed(open, ['merge'], 'free')).toBe(true);
    expect(toolAllowed(open, ['split'], 'free')).toBe(false);
  });
});

describe('validateOptions', () => {
  test('accepts an empty object when every option has a default', () => {
    const result = validateOptions('merge', {});
    expect(result.ok).toBe(true);
  });

  test('rejects an unknown key instead of ignoring it', () => {
    // `.strict()` is what makes a typo in an option name a 422 rather than a silently ignored setting.
    const result = validateOptions('merge', { bookmarkz: 'keep' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toContain('bookmarkz');
  });

  test('rejects an out-of-range number', () => {
    const result = validateOptions('pdf-to-images', { dpi: 10_000 });
    expect(result.ok).toBe(false);
  });

  test('accepts the comma-separated spelling a `text` control produces', () => {
    // `remove-metadata.keep` is the one option whose UI control cannot produce an array: the panel's default branch
    // sends exactly what the user typed. Both spellings have to validate, or the tool is enabled and unsettable.
    const asArray = validateOptions('remove-metadata', { keep: ['docinfo'] });
    expect(asArray.ok).toBe(true);
    if (asArray.ok) expect(asArray.options.keep).toEqual(['docinfo']);

    const asString = validateOptions('remove-metadata', { keep: 'xmp, docinfo' });
    expect(asString.ok).toBe(true);
    if (asString.ok) expect(asString.options.keep).toEqual(['xmp', 'docinfo']);

    // Blank entries are dropped rather than rejected, so a trailing comma is not a 422.
    const trailing = validateOptions('remove-metadata', { keep: 'xmp,' });
    expect(trailing.ok).toBe(true);
    if (trailing.ok) expect(trailing.options.keep).toEqual(['xmp']);

    // An empty form field means "remove everything", which is the documented default.
    const empty = validateOptions('remove-metadata', { keep: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.options.keep).toEqual([]);

    // The coercion must not become a way to smuggle in a value the enum does not have.
    const bogus = validateOptions('remove-metadata', { keep: 'docinfo, exif' });
    expect(bogus.ok).toBe(false);
  });

  test('accepts the comma-separated spelling the OCR form produces, and keeps the default for an empty box', () => {
    // The same coercion as `keep`, for the same reason, and it was missing: `ocr.languages` is an array schema and its
    // control is a text box whose own hint says "e.g. eng, ind — up to three", so the spelling the form promised was
    // the one the schema refused — `Expected array, received string` on a tool whose *required* option that is.
    const asString = validateOptions('ocr', { languages: 'eng, ind' });
    expect(asString.ok).toBe(true);
    if (asString.ok) expect(asString.options.languages).toEqual(['eng', 'ind']);

    const asArray = validateOptions('ocr', { languages: ['eng+ind'] });
    expect(asArray.ok).toBe(true);
    if (asArray.ok) expect(asArray.options.languages).toEqual(['eng+ind']);

    // An empty box means "not specified" — unlike `keep`, where empty is a real answer ("remove everything") — so it
    // resolves to the documented default rather than to a 422 about needing at least one language.
    const empty = validateOptions('ocr', { languages: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.options.languages).toEqual(['eng']);

    // And the coercion is not a way to smuggle a language tesseract does not have.
    const bogus = validateOptions('ocr', { languages: 'eng, english' });
    expect(bogus.ok).toBe(false);
  });

  test('reports an unknown tool as a validation issue rather than throwing', () => {
    const result = validateOptions('nope', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('Unknown tool');
  });
});

describe('largestInputBatch', () => {
  /**
   * The number the upload limiter takes as its burst allowance.
   *
   * Asserted as a property rather than as a value, because the value is expected to change: what must never change is
   * that it is the *maximum* over the enabled tools — the moment it is smaller, a request the registry accepts cannot
   * be staged, which is precisely the defect the bucket was introduced for (a 50-file merge behind a 30-per-minute
   * per-file upload limit).
   */
  test('is the maximum over enabled tools, not a hand-written number', () => {
    const enabled = TOOLS.filter((tool) => tool.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    expect(largestInputBatch()).toBe(Math.max(...enabled.map((tool) => tool.input.maxFiles)));
  });

  test('is at least the ceiling of every tool that accepts several files', () => {
    for (const tool of TOOLS) {
      if (!tool.enabled) continue;
      expect(largestInputBatch()).toBeGreaterThanOrEqual(tool.input.maxFiles);
    }
  });
});
