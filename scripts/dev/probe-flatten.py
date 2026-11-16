"""What `flatten_annotations()` actually does to the form fixture — one mode at a time, measured rather than assumed.

The golden suite found two things the handler's own report did not: with `flattenMode: 'annotations'` the filled text
was **gone from the page**, and with `'all'` the job failed because *three widgets* were still in the document. Both
are claims about a file rather than about a return value, so both are measured here.

    docker cp fixtures/generated/form-five-fields-a4.pdf pdf-tools-worker-heavy-1:/tmp/f.pdf
    docker compose exec -T worker-heavy python3 - < scripts/dev/probe-flatten.py

Per mode it prints: the text pdftotext can read, the widgets PyMuPDF can see, the annotation dictionaries left in the
file, and **the baked content stream itself** — because "the appearance was pushed into the page" is a claim about a
content stream, and a count of bytes cannot tell a baked checkbox from a baked text field.
"""

from __future__ import annotations

import json
import os
import subprocess

import pikepdf
import pymupdf
from pikepdf import Name, String

SOURCE = "/tmp/f.pdf"
VALUES = {"employee_name": "Boni Pratama", "acknowledged": True}


def widget_index(pdf: pikepdf.Pdf) -> dict[str, list]:
    """Widgets by fully qualified name, the way a reader addresses them."""
    seen: dict[str, list] = {}
    for page in pdf.pages:
        for annot in page.obj.get("/Annots", []):
            if annot.get("/Subtype") != Name("/Widget"):
                continue
            parts = []
            current = annot
            for _ in range(32):
                if current is None:
                    break
                name = current.get("/T")
                if name is not None:
                    parts.append(str(name))
                current = current.get("/Parent")
            seen.setdefault(".".join(reversed(parts)), []).append(annot)
    return seen


def write_values(pdf: pikepdf.Pdf) -> None:
    """The write half of the handler's Python, so the probe flattens the same file the handler would."""
    for name, value in VALUES.items():
        for annot in widget_index(pdf).get(name, []):
            if isinstance(value, bool):
                ap = annot.get("/AP")
                states = [str(k) for k in ap["/N"].keys()] if ap and "/N" in ap else ["/Yes"]
                target = next((s for s in states if s != "/Off"), "/Yes")
                annot["/V"] = Name(target if value else "/Off")
                annot["/AS"] = Name(target if value else "/Off")
            else:
                annot["/V"] = String(str(value))
    pdf.acroform.generate_appearances_if_needed()


def state_of(path: str) -> str:
    """Per-widget: type, whether it has an appearance, and the appearance states it can switch between."""
    with pikepdf.Pdf.open(path) as pdf:
        rows = []
        for name, annots in widget_index(pdf).items():
            for annot in annots:
                ap = annot.get("/AP")
                states = sorted(str(k) for k in ap["/N"].keys()) if ap is not None and "/N" in ap else []
                rows.append({"name": name, "FT": str(annot.get("/FT")), "AP": ap is not None, "states": states})
        return json.dumps(rows, indent=None)


def content_of(path: str) -> str:
    """The page's content streams, concatenated and inflated — what a flatten actually pushed into the page."""
    with pikepdf.Pdf.open(path) as pdf:
        chunks = []
        for page in pdf.pages:
            contents = page.obj.get("/Contents")
            streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
            for stream in streams:
                if stream is None:
                    continue
                try:
                    chunks.append(bytes(stream.read_bytes()).decode("latin-1"))
                except Exception as error:  # noqa: BLE001 — reported, not raised: a probe must keep going
                    chunks.append(f"<unreadable: {error}>")
        return "\n--- stream ---\n".join(chunks)


def report(label: str, path: str) -> None:
    document = pymupdf.open(path)
    widgets = [(w.field_name, str(w.field_value)) for page in document for w in page.widgets()]
    text = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, check=False).stdout
    with pikepdf.Pdf.open(path) as pdf:
        annots = [str(a.get("/Subtype")) for page in pdf.pages for a in page.obj.get("/Annots", [])]
        fields = len(list(pdf.acroform.fields)) if "/AcroForm" in pdf.Root else 0
    print(
        f"\n== {label} → {os.path.basename(path)} ({os.path.getsize(path)} bytes)\n"
        f"   pdf text: {text.strip()!r}\n"
        f"   widgets (pymupdf): {widgets}\n"
        f"   annotations in /Annots: {annots}\n"
        f"   /AcroForm fields: {fields}\n"
        f"   widgets with appearances: {state_of(path)}\n"
        f"   page content: {content_of(path)[:400]!r}"
    )


report("the source", SOURCE)

with pikepdf.Pdf.open(SOURCE) as pdf:
    write_values(pdf)
    pdf.save("/tmp/probe-nofill.pdf")
report("filled, no flatten", "/tmp/probe-nofill.pdf")

# flattenMode 'annotations': the handler moves the non-widget annotations aside, flattens, then puts them back.
with pikepdf.Pdf.open("/tmp/probe-nofill.pdf") as pdf:
    kept = []
    for page in pdf.pages:
        others = [a for a in page.obj.get("/Annots", []) if a.get("/Subtype") != Name("/Widget")]
        if others:
            kept.append((page, others))
            page.obj["/Annots"] = pikepdf.Array(
                [a for a in page.obj.get("/Annots", []) if a.get("/Subtype") == Name("/Widget")]
            )
    pdf.flatten_annotations()
    for page, others in kept:
        page.obj["/Annots"] = pikepdf.Array(others)
    pdf.save("/tmp/probe-flat-annotations.pdf")
report("flatten, flattenMode 'annotations' (what the handler does today)", "/tmp/probe-flat-annotations.pdf")

# The same flatten with nothing moved aside — the plain call the 'all' branch makes.
with pikepdf.Pdf.open("/tmp/probe-nofill.pdf") as pdf:
    pdf.flatten_annotations()
    pdf.save("/tmp/probe-flat-all.pdf")
report("flatten, nothing moved aside (flattenMode 'all')", "/tmp/probe-flat-all.pdf")

# The handler's real 'all' path also has to leave /AcroForm behind rather than a form with no widgets in it.
with pikepdf.Pdf.open("/tmp/probe-flat-all.pdf") as pdf:
    if "/AcroForm" in pdf.Root:
        del pdf.Root["/AcroForm"]
    for page in pdf.pages:
        page.obj["/Annots"] = pikepdf.Array(
            [a for a in page.obj.get("/Annots", []) if a.get("/Subtype") != Name("/Widget")]
        )
    pdf.save("/tmp/probe-flat-all-cleaned.pdf")
report("flatten 'all', then /AcroForm and the leftover widgets removed", "/tmp/probe-flat-all-cleaned.pdf")
