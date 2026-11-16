"""Two candidate writers for `fill-form`, judged by three independent readings.

The measurements that led here:

  * **pikepdf's `field.value` setter corrupts a checkbox that has an appearance.** With `/AP /N` carrying `/Yes` and
    `/Off`, `field.value = pikepdf.Name('/Yes')` writes `/V = //Off` — a *different name*, which every reader reports as
    unchecked — while `is_checked` returns True. The same call against a checkbox with **no** `/AP` works. That is
    reproducible in 12 lines and it is why a form handler cannot trust one engine's own account of what it did.
  * **PyMuPDF's `widget.field_value` + `update()`** is the doc's recipe (`14-SIGN-AND-FORMS.md` §4), and on a fixture
    with `/NeedAppearances` the checkbox still read back `/Off` from both engines while poppler drew a tick.

So this probe builds a *clean* fixture — a checkbox with per-state appearances and no `/NeedAppearances`, a text field
with no appearance at all (the common real-world shape) — and then writes the same three values two ways, reading the
result back with pikepdf, with PyMuPDF, and from a render.

    docker compose exec -T worker-heavy python3 - < scripts/dev/probe-fill.py
"""

from __future__ import annotations

import json
import os

import pikepdf
import pymupdf

BASE = "/tmp/probe-clean-form.pdf"
TEXT_BOX = (72, 640, 320, 664)
CHECK_BOX = (72, 600, 86, 614)


def build_clean_form() -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(595, 842))
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"), BaseFont=pikepdf.Name("/Helvetica")
        )
    )
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font))

    def form_xobject(body: bytes) -> pikepdf.Stream:
        return pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                body,
                Type=pikepdf.Name("/XObject"),
                Subtype=pikepdf.Name("/Form"),
                FormType=1,
                BBox=pikepdf.Array([0, 0, 14, 14]),
            )
        )

    text = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"),
            T=pikepdf.String("employee_name"),
            Rect=pikepdf.Array(list(TEXT_BOX)),
            F=4,
            P=page.obj,
            DA=pikepdf.String("/Helv 12 Tf 0 g"),
            MK=pikepdf.Dictionary(BC=pikepdf.Array([0.8, 0.8, 0.8])),
        )
    )
    check = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Btn"),
            T=pikepdf.String("acknowledged"),
            Rect=pikepdf.Array(list(CHECK_BOX)),
            F=4,
            P=page.obj,
            V=pikepdf.Name("/Off"),
            AS=pikepdf.Name("/Off"),
            # Keyword names go in **without** the slash: `Dictionary(**{'/Yes': …})` produces the key `//Yes`, which is
            # a different name from `/Yes` — so `/AS /Yes` matches no appearance and the box renders empty forever.
            AP=pikepdf.Dictionary(
                N=pikepdf.Dictionary(
                    Yes=form_xobject(b"q 0 0 0.6 rg 2 2 10 10 re f Q"),
                    Off=form_xobject(b"q 0.5 0.5 0.5 RG 1 w 1 1 12 12 re S Q"),
                )
            ),
        )
    )
    page.obj["/Annots"] = pikepdf.Array([text, check])
    # No /NeedAppearances: a form that says "regenerate my appearances" makes every reader disagree about what it drew,
    # which is what made the earlier probe unreadable.
    pdf.Root.AcroForm = pdf.make_indirect(pikepdf.Dictionary(Fields=pikepdf.Array([text, check])))
    pdf.save(BASE)
    print(f"built a clean form: {os.path.getsize(BASE)} bytes")


def ink(path: str, rect: tuple[float, float, float, float]) -> int:
    document = pymupdf.open(path)
    page = document[0]
    x0, y0, x1, y1 = rect
    clip = pymupdf.Rect(x0, page.rect.height - y1, x1, page.rect.height - y0)
    pixmap = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY, clip=clip)
    return sum(1 for value in pixmap.samples if value < 200)


def report(label: str, path: str) -> None:
    print(f"\n== {label} → {path} ({os.path.getsize(path)} bytes)")
    with pikepdf.Pdf.open(path) as pdf:
        for field in pdf.acroform.fields:
            obj = field.obj
            states = list(obj.get("/AP", {}).get("/N", {}).keys()) if "/AP" in obj else []
            print(
                "   pikepdf: "
                + json.dumps(
                    {
                        "name": field.fully_qualified_name,
                        "V": str(obj.get("/V")),
                        "AS": str(obj["/AS"]) if "/AS" in obj else None,
                        "AP/N states": states,
                        "is_checked": field.is_checked,
                    }
                )
            )
    for widget in pymupdf.open(path)[0].widgets():
        print(f"   pymupdf: name={widget.field_name!r} value={str(widget.field_value)!r}")
    print(f"   render: text box ink={ink(path, TEXT_BOX)}  checkbox box ink={ink(path, CHECK_BOX)}")


build_clean_form()
report("source (empty)", BASE)

# ── Writer A: PyMuPDF, the doc's recipe ───────────────────────────────────────────────────────────────────────────
doc = pymupdf.open(BASE)
for widget in doc[0].widgets():
    if widget.field_name == "employee_name":
        widget.field_value = "Boni Pratama"
    elif widget.field_name == "acknowledged":
        widget.field_value = True
    widget.update()
doc.save("/tmp/probe-writer-a.pdf", garbage=3, deflate=True)
report("writer A: PyMuPDF widget.field_value + update()", "/tmp/probe-writer-a.pdf")

# ── Writer B: pikepdf, but buttons written directly rather than through the setter ────────────────────────────────
with pikepdf.Pdf.open(BASE) as pdf:
    acroform = pdf.acroform
    for field in acroform.fields:
        if field.fully_qualified_name == "employee_name":
            field.value = pikepdf.String("Boni Pratama")
        elif field.fully_qualified_name == "acknowledged":
            # Deliberately *not* the setter: with /AP present it writes `//Off`, measured twice.
            field.obj["/V"] = pikepdf.Name("/Yes")
            field.obj["/AS"] = pikepdf.Name("/Yes")
    acroform.generate_appearances_if_needed()
    # ...and again after generation, because the generator recomputes state names for buttons.
    for field in acroform.fields:
        if field.fully_qualified_name == "acknowledged":
            field.obj["/V"] = pikepdf.Name("/Yes")
            field.obj["/AS"] = pikepdf.Name("/Yes")
    pdf.save("/tmp/probe-writer-b.pdf")
report("writer B: pikepdf, direct /V + /AS", "/tmp/probe-writer-b.pdf")

# ── Writer C: pikepdf's own setter for the checkbox, now that the fixture's state names are correct ──────────────
with pikepdf.Pdf.open(BASE) as pdf:
    acroform = pdf.acroform
    for field in acroform.fields:
        if field.fully_qualified_name == "employee_name":
            field.value = pikepdf.String("Boni Pratama")
        elif field.fully_qualified_name == "acknowledged":
            field.value = pikepdf.Name("/Yes")
    acroform.generate_appearances_if_needed()
    pdf.save("/tmp/probe-writer-c.pdf")
report("writer C: pikepdf field.value (the obvious spelling)", "/tmp/probe-writer-c.pdf")

# ── Flatten: the two candidate mechanisms, each judged by whether the value survives as page content ─────────────
flat_a = pymupdf.open("/tmp/probe-writer-a.pdf")
flat_a.bake()
flat_a.save("/tmp/probe-flat-a.pdf", garbage=3, deflate=True)
report("flatten A: pymupdf Doc.bake()", "/tmp/probe-flat-a.pdf")

with pikepdf.Pdf.open("/tmp/probe-writer-b.pdf") as pdf:
    pdf.flatten_annotations()
    pdf.save("/tmp/probe-flat-b.pdf")
report("flatten B: pikepdf flatten_annotations()", "/tmp/probe-flat-b.pdf")

import subprocess  # noqa: E402

for label, path in (("writer A", "/tmp/probe-writer-a.pdf"), ("flat A", "/tmp/probe-flat-a.pdf")):
    text = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, check=False).stdout
    print(f"pdftotext on {label}: {text.strip()!r}")
