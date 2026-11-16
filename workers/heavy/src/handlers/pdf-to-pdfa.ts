import { join } from 'node:path';
import { config } from '@pdftools/config';
import type { PdfToPdfaOptions } from '@pdftools/contracts/tools';
import {
  PDFA_INTENT_FILENAME,
  buildPdfaOutputIntent,
  censusFonts,
  censusImages,
  findPdfaProfile,
  gsOrThrow,
  hasPdfaOutputIntent,
  readPdfaClaim,
  runQpdf,
  verifyPdfa,
} from '@pdftools/engines';
import { JobFailure } from '@pdftools/errors';
import type { Handler } from '@pdftools/worker-shared';

/**
 * `pdf-to-pdfa` — `docs/09-PDF-A.md`.
 *
 * The pipeline is deliberately four steps rather than one clever Ghostscript invocation, because when validation
 * fails you need to know *which* step is at fault:
 *
 *   embed fonts → downsample images → PDF/A pass → validate
 *
 * Validation is not optional when `PDFA_VALIDATE=true`: an invalid file labelled PDF/A is worse than a failed
 * job, because an archive that silently does not conform is discovered years later by an auditor. When veraPDF is
 * not installed the handler says so instead of claiming conformance it did not verify — and when it *is* installed the
 * output that fails validation is **withheld** (`PDFA_CONFORMANCE_FAILED`), not delivered with a caveat: the tool's
 * promise is an archival document, and "almost archival" is not one. veraPDF ships in this image (`Dockerfile.workers`,
 * ~18 MB for the CLI pack), so `PDFA_VALIDATE=true` is the ordinary configuration rather than an aspiration.
 *
 * **The output intent is a step of its own, and it used to be missing.** `gs -dPDFA=1` writes the XMP claim and
 * nothing else; the archival intent — an `/OutputIntents` array pointing at an embedded ICC profile with
 * `/S /GTS_PDFA1` — comes from a PostScript preamble the caller supplies (`packages/engines/src/pdfa.ts`, which
 * explains why). Without it this tool produced a file whose metadata said PDF/A and whose contents were not, and
 * nothing could see the difference: the claim is in one object and the fact is in another, `PDFA_VALIDATE` is off by
 * default, and the tool had never run because of its plan gate. The preamble is now written per job into the work
 * directory and passed as the first input, with `--permit-file-read` for the profile, because Ghostscript refuses to
 * read a file it was not explicitly permitted to read — and a refused read leaves a job that *succeeds* with no
 * intent, which is the same silent failure one layer down.
 *
 * Two further facts came out of running it, and both are in the code rather than in a comment: a colour-managed
 * `forceSrgb` has to ask for `sRGB` (Ghostscript cannot honour `UseDeviceIndependentColor` at PDF/A-2 and -3 — it
 * reverts per page and still exits 0), and the output is **read back** after the pass, so `OUTPUT_INTENT_WRITTEN`
 * describes the file rather than the intention. The read-back is `hasPdfaOutputIntent` in
 * `packages/engines/src/pdfa.ts`, which searches the inflated object streams as well as the raw bytes; without that
 * half it reports every PDF/A-2 output as intent-less, because that is where Ghostscript puts the dictionary.
 *
 * **The `changes` list is measured, and `embedAllFonts` is read.** Both of those became true sentences about the code
 * only in this pass. The list was three fixed entries — a font pass, an image pass, an XMP rewrite — reported for every
 * document, so a text-only file whose fonts were already embedded was told that its images had been reduced from
 * 600 dpi. `pdffonts` and `pdfimages -list` are now read before the work starts and an entry appears only when there
 * was something to change, carrying the counts that say so; the same census supplies the metrics. And `embedAllFonts`
 * — declared, defaulted to `true`, and never once read — now selects whether the font pass runs at all, which is the
 * one thing its name promises.
 *
 * What has **not** changed is the refusal to deliver unvalidated output: the delivered file is read back
 * (`pdffonts`, the intent), and a verdict that is not a pass fails the job with the validator's report instead of
 * handing back something that claims to be archival (`PDFA_CONFORMANCE_FAILED`).
 */

/**
 * The resolution the normalising pass reduces images to, and the threshold that decides which ones it touches.
 *
 * One constant because two parties now depend on the number agreeing: the Ghostscript arguments below and the census
 * that says how many images were above it. `-dImageDownsampleThreshold=1.0` is what makes the sentence "images above
 * this were reduced" exactly true — Ghostscript's default threshold is **1.5**, so at 300 dpi it leaves a 400 dpi
 * image alone while a census counting "> 300" reports it as reduced. Measured, and the reason this is a constant
 * rather than two literals in the same function.
 */
const IMAGE_DPI = 300;

export const pdfToPdfa: Handler<PdfToPdfaOptions> = async (ctx) => {
  const { files, options, workDir, outputDir, report, limits, signal } = ctx;
  const input = files[0]!.path;
  const changes: Array<Record<string, unknown>> = [];
  const warnings: Array<{ code: string; detail?: string }> = [];

  const runOpts = {
    cwd: workDir,
    timeoutMs: limits.timeoutSeconds * 1000,
    memoryMb: limits.memoryMb,
    ...(signal ? { signal } : {}),
  };

  // ── 1. Refuse encrypted input: PDF/A forbids encryption ────────────────────
  const encryption = await runQpdf(['--show-encryption', input], { cwd: workDir, timeoutMs: 20_000 });
  if (encryption.code === 0 && !/not encrypted|File is not encrypted/i.test(encryption.stdout)) {
    throw new JobFailure('ENCRYPTED_INPUT', {
      message: 'Archival conversion needs an unencrypted document. Remove the password first.',
    });
  }

  // ── 1½. What the document contains, before anything is done to it ───────────
  //
  // The `changes` list used to be fixed: three entries, the same for every document, including one whose fonts were
  // already embedded and which contained no image at all. That is a false statement about the caller's file rather
  // than a terse one, so both dimensions are now measured on the way in. `null` means the reader could not be run —
  // which is reported rather than turned into a zero, because "no font needed embedding" and "nobody looked" are
  // different sentences.
  const fontsBefore = await censusFonts(input, { cwd: workDir, timeoutMs: 60_000 });
  const imagesBefore = await censusImages(input, { cwd: workDir, timeoutMs: 60_000, dpi: IMAGE_DPI });
  if (!fontsBefore || !imagesBefore) {
    warnings.push({
      code: 'INGEST_CENSUS_UNAVAILABLE',
      detail: `The document's ${!fontsBefore ? 'fonts (`pdffonts`)' : 'images (`pdfimages`)'} could not be listed, so this job's \`changes\` are incomplete: what had to be embedded or reduced for this file was not measured.`,
    });
  }

  report({ progress: 12, phase: 'processing', message: 'Embedding fonts.' });

  // ── 2. Font embedding: the single most common cause of a failed validation ──
  //
  // `embedAllFonts: false` means "do not force it", and forcing it was the whole of the old behaviour: the option was
  // declared, defaulted and never read, so a document whose fonts were already embedded was rewritten by a full
  // Ghostscript pass anyway. Skipping is the honest reading of the flag. What it costs is measured rather than
  // assumed: the PDF/A pass below embeds fonts itself (`gs -dPDFA=2` alone turns this fixture's non-embedded Helvetica
  // into an embedded subset), so this prepass is an extra rewrite rather than the reason fonts end up embedded. What
  // protects the archival claim is therefore the read-back census of the delivered file (step 4½) and the validator —
  // not this step, which is why skipping it is safe and why `FONT_EMBEDDING_SKIPPED` says exactly what was skipped.
  let prepared = input;
  // Both are read from the **delivered** file rather than from this pass's own output, and that distinction was
  // measured rather than assumed: the PDF/A pass embeds fonts itself, so a document whose prepass is skipped still
  // comes out with an embedded font (probed: `gs -dPDFA=2` alone turns the fixture's non-embedded Helvetica into an
  // embedded subset). Measuring here would therefore attribute to the prepass work the second pass also does, and a
  // caller reading `fontsEmbedded` is asking about the file they received.
  let fontsEmbedded: number | null = null;
  let fontsSubstituted: number | null = null;
  // Assigned where the work happens rather than derived from the option when the metrics are assembled.
  //
  // The first version wrote `fontPass: options.embedAllFonts ? 'embed' : 'skipped'`, which reads as the same sentence
  // and is not: it reports what was *asked for* rather than what ran, so a handler that ignored the flag would still
  // say `skipped`. Falsify's `pdfa-embed-all-fonts` claim caught exactly that — it patches the condition below and the
  // case passed anyway, because the metric was never downstream of it. One assignment inside the branch keeps the two
  // statements about the same event.
  let fontPass: 'embed' | 'skipped' = 'skipped';

  if (options.embedAllFonts) {
    fontPass = 'embed';
    const embedded = join(workDir, 'fonts-embedded.pdf');
    await gsOrThrow(
      [
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        '-sDEVICE=pdfwrite',
        '-dPDFSETTINGS=/prepress',
        '-dEmbedAllFonts=true',
        '-dSubsetFonts=true',
        '-dCompatibilityLevel=1.7',
        `-sOutputFile=${embedded}`,
        input,
      ],
      runOpts,
    );
    prepared = embedded;
  } else {
    warnings.push({
      code: 'FONT_EMBEDDING_SKIPPED',
      detail:
        'embedAllFonts is off, so the font-embedding prepass was skipped and the document goes straight to the PDF/A pass, which embeds the fonts it can itself. Fewer rewrites, and the delivered file is still read back and validated below — but a font the pass cannot find a program for is reported as FONT_NOT_EMBEDDED and refused by the validator rather than fixed by the prepass.',
    });
  }

  // ── 3. Downsample images so the archival file stays reasonable ─────────────
  report({ progress: 40, phase: 'processing', message: 'Normalising images.' });
  const downsampled = join(workDir, 'downsampled.pdf');
  // The threshold is explicit at 1.0 rather than left at Ghostscript's 1.5 default: the census below states which
  // images are above 300 dpi from the same number, and a default that quietly spares everything under 450 dpi would
  // make that statement untrue for real documents.
  await gsOrThrow(
    [
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      '-sDEVICE=pdfwrite',
      '-dDownsampleColorImages=true',
      `-dColorImageResolution=${IMAGE_DPI}`,
      '-dColorImageDownsampleThreshold=1.0',
      '-dDownsampleGrayImages=true',
      `-dGrayImageResolution=${IMAGE_DPI}`,
      '-dGrayImageDownsampleThreshold=1.0',
      '-dDownsampleMonoImages=true',
      `-dMonoImageResolution=${IMAGE_DPI}`,
      '-dMonoImageDownsampleThreshold=1.0',
      `-sOutputFile=${downsampled}`,
      prepared,
    ],
    runOpts,
  );
  const imagesDownsampled = imagesBefore?.aboveDpi ?? 0;
  if (imagesBefore && imagesDownsampled > 0) {
    changes.push({
      kind: 'IMAGE_DOWNSAMPLED',
      detail: `${imagesDownsampled} of the ${imagesBefore.total} image(s) were above ${IMAGE_DPI} dpi (the highest was ${Math.round(imagesBefore.maxDpi)} dpi) and were reduced to it.`,
    });
  }

  // ── 4. The PDF/A pass itself, with the output intent it cannot be archival without ──
  report({ progress: 65, phase: 'processing', message: `Writing PDF/A-${options.profile}.` });
  const outputPath = join(outputDir, `archival-${options.profile}.pdf`);
  // The level is the profile's first character, not a two-way branch. It used to be `profile === '1b' ? '1' : '2'`,
  // so a request for PDF/A-3 was answered with a PDF/A-2 file — and, worse, one whose own XMP said `pdfaid:part='2'`,
  // which is a conformance claim the caller did not make. Ghostscript 10.05.1 supports `-dPDFA=3` (verified: part 3,
  // same intent, same pages), so nothing is lost by making the mapping total.
  const pdfaLevel = options.profile.charAt(0);
  // `sRGB`, not `UseDeviceIndependentColor`, and the difference is not cosmetic. Measured against Ghostscript
  // 10.05.1: at PDF/A-1 the device-independent request is honoured, but at PDF/A-2 and -3 `pdfwrite` cannot honour it
  // and says so on every page — `cannot guarantee creating a conformant PDF/A-2 file with device-independent colour …
  // reverting to normal output`. The exit code stays 0, the intent and the `pdfaid` claim still land, and the colour
  // conversion the caller asked for quietly does not happen. `sRGB` is also the honest strategy here for a second
  // reason: it is the space the embedded intent *names*, so the content and the intent agree instead of merely both
  // being present.
  const strategy = options.forceSrgb ? 'sRGB' : 'LeaveColorUnchanged';

  const intent = await findPdfaProfile(options.forceSrgb);
  if (!intent) {
    // Not a warning: a PDF/A file without an output intent is not a PDF/A file, and the whole point of this tool is
    // the archival claim. Failing here is the same shape as `verifyPdfa` failing when veraPDF is absent.
    throw new JobFailure('ENGINE_UNAVAILABLE', {
      message: `No ${options.forceSrgb ? 'sRGB' : 'CMYK'} ICC profile was found to embed as the PDF/A output intent. Install Ghostscript's ICC profiles or set ENGINE_GS_ICC_PROFILE.`,
    });
  }
  const intentPath = join(workDir, PDFA_INTENT_FILENAME);
  await Bun.write(intentPath, buildPdfaOutputIntent(intent));

  const pdfaPass = await gsOrThrow(
    [
      `-dPDFA=${pdfaLevel}`,
      '-dBATCH',
      '-dNOPAUSE',
      '-dQUIET',
      '-dNOOUTERSAVE',
      // Ghostscript ≥ 9.50 refuses `file` on a path it was not explicitly pointed at, and the refusal is silent from
      // the outside: the preamble reports it and the job still succeeds with no intent.
      `--permit-file-read=${intent.profilePath}`,
      `-sColorConversionStrategy=${strategy}`,
      '-sDEVICE=pdfwrite',
      // Policy 1 = convert what is possible and continue; the validator below is what makes that acceptable.
      '-dPDFACompatibilityPolicy=1',
      `-sOutputFile=${outputPath}`,
      // The preamble comes *before* the document: it is a prefix program, not another input file.
      intentPath,
      downsampled,
    ],
    runOpts,
  );

  // Ghostscript says on stderr when it has given up on the colour strategy, and `-dQUIET` does not suppress it. It is
  // a warning rather than a failure because the archival claim survives the revert (verified: the intent and the
  // `pdfaid` identifiers are both still written) — but a caller who asked for converted colours has to be told that
  // they are not converted. With the strategy chosen above this should never fire; it is here because the engine is
  // the only party that knows, and a future Ghostscript may refuse a strategy this one accepts.
  if (/reverting to normal output/i.test(pdfaPass.stderr)) {
    const engineLine = pdfaPass.stderr.trim().split('\n').pop()?.trim() ?? '';
    warnings.push({
      code: 'COLOUR_STRATEGY_REVERTED',
      detail: `Ghostscript could not honour ${strategy} for PDF/A-${pdfaLevel} and processed the pages in normal output mode, so colours may remain in their original spaces${engineLine ? `: ${engineLine}` : '.'}`,
    });
  }

  // "The preamble ran" and "the claim is in the file" are different statements, and only the second one is worth
  // making. Ghostscript exits 0 when the preamble's own read of the ICC profile is refused, which leaves a file that
  // claims PDF/A and has no intent — the exact failure this tool exists to prevent, and one no response-level
  // assertion can see. So the file is read back before it is described, and both halves of the claim are read: the
  // **identification** in the XMP (`pdfaid:part`) and the **output intent** (`/OutputIntents` + `/GTS_PDFA1` +
  // `/DestOutputProfile`). The two live in different objects, which is the whole reason this tool exists.
  //
  // The XMP half used to be an unconditional change entry — "pdfaid:part/conformance set for profile N", pushed because
  // the pass was *asked* for that level rather than because the file says it. It is the same defect family as the fixed
  // `changes` list: a statement about the caller's file that nobody measured.
  const deliveredBytes = new Uint8Array(await Bun.file(outputPath).arrayBuffer());
  const claim = readPdfaClaim(deliveredBytes);
  if (!claim) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'ghostscript',
      message: `The PDF/A-${pdfaLevel} pass delivered a file whose own metadata declares no PDF/A identification, so it is not archival and has not been delivered. The delivered bytes carry no \`pdfaid:part\` in either their raw streams or their inflated ones.`,
      stderrTail: pdfaPass.stderr,
    });
  }
  if (claim.part !== pdfaLevel) {
    // The mapped-level bug, now impossible to ship: `-dPDFA=3` used to be answered by a PDF/A-2 file whose own XMP said
    // `pdfaid:part='2'`, which is a conformance claim the caller never made. The change list would have said
    // "pdfaid set for profile 3b" over a file that said nothing of the kind.
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'ghostscript',
      message: `The PDF/A-${pdfaLevel} pass delivered a file whose own metadata declares pdfaid:part='${claim.part}' — the file claims a level nobody asked for, so it has not been delivered.`,
      stderrTail: pdfaPass.stderr,
    });
  }
  changes.push({
    kind: 'XMP_REWRITTEN',
    detail: `The delivered file's own metadata declares pdfaid:part='${claim.part}'${claim.conformance ? ` and pdfaid:conformance='${claim.conformance}'` : ''}, read back out of its bytes (object streams included).`,
  });

  if (!hasPdfaOutputIntent(deliveredBytes)) {
    throw new JobFailure('CONVERSION_FAILED', {
      engine: 'ghostscript',
      message: `The PDF/A-${pdfaLevel} pass produced a file with no output intent, so it is not archival and has not been delivered. The preamble reads the profile at ${intent.profilePath}; check that Ghostscript may read it and that its stderr was not reporting a refused read.`,
      stderrTail: pdfaPass.stderr,
    });
  }
  changes.push({
    kind: 'OUTPUT_INTENT_WRITTEN',
    detail: `${intent.conditionIdentifier} profile embedded (${intent.components} components), verified in the output`,
  });

  // ── 4½. What the delivered file actually contains, read back out of it ──────
  //
  // The font question is the one an archive is really asking: were the fonts the document names the ones that ended up
  // in it? `pdffonts` answers both halves — a font with no program (`emb=no`) is what PDF/A forbids, and a font the
  // reader had to substitute (`sub=yes`) is a document that will not render the way its author saw it. The counts are
  // the difference between the input's census and the delivered file's, so a document whose fonts were already
  // embedded reports nothing rather than reporting a rewrite nobody needed.
  const fontsAfter = await censusFonts(outputPath, { cwd: workDir, timeoutMs: 60_000 });
  if (fontsBefore && fontsAfter) {
    fontsEmbedded = Math.max(0, fontsBefore.notEmbedded - fontsAfter.notEmbedded);
    fontsSubstituted = fontsAfter.substituted;
    if (fontsEmbedded > 0) {
      changes.push({
        kind: 'FONT_EMBEDDED',
        detail: `${fontsEmbedded} of the ${fontsBefore.total} font reference(s) in the input had no font program; every font in the delivered file is embedded.`,
      });
    }
    if (fontsAfter.substituted > 0) {
      // Documented for this tool from its first draft and never once emitted until now. It is a fact about the
      // *delivered* file rather than about the job, and it is the kind of fact an archive cares about: a substituted
      // font renders differently from the one the document names, and nothing in the PDF/A claim reveals that.
      warnings.push({
        code: 'FONT_SUBSTITUTED',
        detail: `${fontsAfter.substituted} of the ${fontsAfter.total} font(s) in the delivered file are substitutes for the family the document names — a base-14 font with no program can only be embedded by substituting a real one for it. The text will render in the substitute, not in the named family.`,
      });
    }
    if (fontsAfter.notEmbedded > 0) {
      // Cannot happen with validation on: a font without a program is exactly what veraPDF refuses, and the refusal is
      // below. It is reported rather than asserted because with `PDFA_VALIDATE=false` a deployment may deliver this
      // file, and a caller in that configuration has no other way to learn that the promise did not hold.
      warnings.push({
        code: 'FONT_NOT_EMBEDDED',
        detail: `${fontsAfter.notEmbedded} of the ${fontsAfter.total} font(s) in the delivered file have no embedded font program, which PDF/A forbids. Enable validation, or run the job with embedAllFonts on.`,
      });
    }
  }
  if (!options.forceSrgb) {
    warnings.push({
      code: 'COLOURS_NOT_CONVERTED',
      detail:
        'forceSrgb is off, so the content was left in its own colour spaces while the output intent names CMYK. A strict validator may treat that mismatch as a conformance problem; turn forceSrgb on to convert and match.',
    });
  }

  // ── 5. Conformance check ───────────────────────────────────────────────────
  report({ progress: 88, phase: 'finalizing', message: 'Checking conformance.' });
  let conformance: Record<string, unknown>;

  if (config.pdfaValidate) {
    // The claim in the file and the fact about the file are different objects, and this is the step that makes them
    // the same sentence: veraPDF opens the produced document and validates it against the profile the caller asked
    // for. A rejection throws, so the job fails **without delivering an output** — an archive that silently does not
    // conform is discovered years later by an auditor, and a caller who asked for archival output is owed the
    // difference now. The validator's version travels with the result because "validated" is not evidence on its own.
    const validation = await verifyPdfa(outputPath, options.profile, { ...runOpts, timeoutMs: 180_000 });
    conformance = {
      tool: 'verapdf',
      version: validation.version,
      result: 'PASS',
      profile: options.profile,
    };
    changes.push({
      kind: 'CONFORMANCE_VALIDATED',
      detail: `veraPDF ${validation.version} validated the output as PDF/A-${options.profile}`,
    });
  } else {
    conformance = {
      tool: null,
      result: 'NOT_VALIDATED',
      profile: options.profile,
      detail: 'PDFA_VALIDATE is off, so conformance was not verified on this installation.',
    };
    warnings.push({
      code: 'CONFORMANCE_NOT_VALIDATED',
      detail:
        'This file was produced with the PDF/A profile but has not been validated. Enable PDFA_VALIDATE to check it.',
    });
  }

  const outputBytes = Bun.file(outputPath).size;
  const inputBytes = Bun.file(input).size;

  return {
    outputs: [{ name: `archival-${options.profile}.pdf`, mime: 'application/pdf', primary: true }],
    metrics: {
      inputBytes,
      outputBytes,
      profile: options.profile,
      // What the two censuses measured, absent when they could not run (the warning above names which). The document's
      // own numbers, not the tool's intentions: `fontsNotEmbeddedInInput` is what the file arrived with, `fontsEmbedded`
      // is how many of those have a program in the delivered file, `fontsSubstituted` is fonts in the delivered file
      // that are not the family the document names, and `imagesDownsampled` is images that were above the resolution
      // the pass was given. The `InInput` suffix is deliberate: a bare `fontsNotEmbedded` would leave a reader unable
      // to tell which of the two documents it describes, and the whole point of the census is that they differ.
      ...(fontsBefore ? { fontsTotal: fontsBefore.total, fontsNotEmbeddedInInput: fontsBefore.notEmbedded } : {}),
      ...(fontsEmbedded != null ? { fontsEmbedded } : {}),
      ...(fontsSubstituted != null ? { fontsSubstituted } : {}),
      ...(imagesBefore ? { imagesTotal: imagesBefore.total, imagesDownsampled } : {}),
      // Which ingest pass ran, as the code above experienced it. `embedAllFonts: false` is the only way to get
      // `skipped`, and it belongs in the metrics because it is the option's entire observable effect — with it, the
      // job does one fewer rewrite of the document, and nothing about the delivered file says so.
      fontPass,
      outputIntent: {
        profile: intent.profilePath,
        conditionIdentifier: intent.conditionIdentifier,
        components: intent.components,
      },
      changes,
      // The conformance result travels with the job: "we produced a PDF/A" and "we proved it validates" are
      // different claims, and the second one is the one an archive cares about.
      conformance,
    },
    warnings,
    engine: { name: 'ghostscript' },
  };
};
