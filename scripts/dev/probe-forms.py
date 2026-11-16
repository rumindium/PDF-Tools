"""What pikepdf can actually do with AcroForm fields, and whether the result *shows*.

`14-SIGN-AND-FORMS.md` §4 fills forms with PyMuPDF's `widget.update()` and flattens with `doc.bake()`. Before writing a
handler against that recipe, four questions have to be answered by the engine rather than assumed:

  1. Can a form fixture be built in the container (the way `make-encrypted-fixture.ts` builds a protected file)?
  2. Does writing a value through pikepdf produce an appearance stream (`/AP`)? A field whose `/V` is set and whose
     `/AP` is missing is the classic "filled PDF that looks empty in one reader" defect.
  3. How must a **checkbox** state be written so two engines agree? The answer below is not the obvious one.
  4. Does the high-level `pikepdf.form.Form` wrapper survive real documents? Its own docstring says it fails on
     documents with two fields of the same name.

Run inside a worker that has both engines (worker-heavy):

    docker compose exec -T worker-heavy python3 - < scripts/dev/probe-forms.py
"""

from __future__ import annotations

import os

import pikepdf
import pymupdf

PDF = "/tmp/probe-form.pdf"


def box_stream(pdf: pikepdf.Pdf, size: int, body: bytes) -> pikepdf.Stream:
    return pikepdf.Stream(
        pdf,
        body,
        Type=pikepdf.Name("/XObject"),
        Subtype=pikepdf.Name("/Form"),
        FormType=1,
        BBox=pikepdf.Array([0, 0, size, size]),
    )


def build_form() -> None:
    """A three-field form written as dictionaries — the fixture path, not the high-level API."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(595, 842))
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"), BaseFont=pikepdf.Name("/Helvetica")
        )
    )
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font))

    def widget(rect, extra):
        annot = pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            Rect=pikepdf.Array(rect),
            F=4,
            P=page.obj,
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
            **extra,
        )
        return pdf.make_indirect(annot)

    text = widget([72, 640, 320, 664], dict(FT=pikepdf.Name("/Tx"), T=pikepdf.String("employee_name"), MaxLen=80))
    # A checkbox carries an appearance per state, because "checked" is the /Yes appearance being swapped in: a widget
    # with no /AP can hold a value and can never show one.
    check = widget(
        [72, 600, 86, 614],
        dict(
            FT=pikepdf.Name("/Btn"),
            T=pikepdf.String("acknowledged"),
            V=pikepdf.Name("/Off"),
            AS=pikepdf.Name("/Off"),
            AP=pikepdf.Dictionary(
                N=pikepdf.Dictionary(
                    **{
                        "/Yes": pdf.make_indirect(box_stream(pdf, 14, b"q 0 0 0.6 rg 2 2 10 10 re f Q")),
                        "/Off": pdf.make_indirect(box_stream(pdf, 14, b"q 0.5 0.5 0.5 RG 1 w 1 1 12 12 re S Q")),
                    }
                )
            ),
        ),
    )
    choice = widget(
        [72, 560, 240, 584],
        dict(
            FT=pikepdf.Name("/Ch"),
            T=pikepdf.String("department"),
            Opt=pikepdf.Array([pikepdf.String("Finance"), pikepdf.String("IT"), pikepdf.String("Operations")]),
        ),
    )
    duplicate = widget([72, 520, 320, 544], dict(FT=pikepdf.Name("/Tx"), T=pikepdf.String("employee_name")))

    page.obj["/Annots"] = pikepdf.Array([text, check, choice, duplicate])
    pdf.Root.AcroForm = pdf.make_indirect(
        pikepdf.Dictionary(Fields=pikepdf.Array([text, check, choice, duplicate]), NeedAppearances=True)
    )
    pdf.save(PDF)
    print(f"built {os.path.getsize(PDF)} bytes with 4 widgets (3 names, one duplicated)")


def ink_inside(page_index: int, rect: tuple[float, float, float, float], path: str) -> int:
    """Dark pixels inside a PDF-space rectangle, rendered by poppler through PyMuPDF. PDF y counts from the bottom."""
    document = pymupdf.open(path)
    page = document[page_index]
    height = page.rect.height
    x0, y0, x1, y1 = rect
    clip = pymupdf.Rect(x0, height - y1, x1, height - y0)
    pixmap = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY, clip=clip)
    return sum(1 for value in pixmap.samples if value < 200)


def read_back(path: str) -> None:
    with pikepdf.Pdf.open(path) as pdf:
        for field in pdf.acroform.fields:
            obj = field.obj
            print(
                f"  pikepdf: name={field.fully_qualified_name!r} V={str(obj.get('/V'))!r}"
                f" AS={str(obj.get('/AS'))!r} checked={field.is_checked}"
            )
    document = pymupdf.open(path)
    for widget in document[0].widgets():
        print(f"  pymupdf: name={widget.field_name!r} value={str(widget.field_value)!r}")


build_form()

# ── Q2 and Q3: three ways to write the same state, and what each one leaves behind ───────────────────────────────
def write_directly(field) -> None:
    field.obj["/V"] = pikepdf.Name("/Yes")
    field.obj["/AS"] = pikepdf.Name("/Yes")


variants = {
    # The obvious spelling: `field.value = Name('/Yes')`. A `Name` must begin with `/` (a bare `Name('Yes')` raises
    # `ValueError: Name objects must begin with '/'`), so this is the only obvious spelling there is.
    "setter": lambda field: setattr(field, "value", pikepdf.Name("/Yes")),
    # What the format actually asks for: the value *and* the appearance state, pointing at a key that exists in
    # `/AP /N` — the same thing a reader writes when a user ticks the box.
    "direct": write_directly,
}

BASELINE_CHECKBOX_INK = ink_inside(0, (72, 600, 86, 614), PDF)

for label, apply in variants.items():
    with pikepdf.Pdf.open(PDF) as pdf:
        fields = list(pdf.acroform.fields)
        for field in fields:
            if field.fully_qualified_name == "employee_name":
                field.value = pikepdf.String("Boni Pratama")
            elif field.fully_qualified_name == "acknowledged":
                apply(field)
            elif field.fully_qualified_name == "department":
                field.value = pikepdf.String("IT")
        pdf.acroform.generate_appearances_if_needed()
        out = f"/tmp/probe-{label.split()[0]}.pdf"
        pdf.save(out)
    print(f"\n== {label} → {out}")
    read_back(out)
    print(f"  ink in the checkbox box: {ink_inside(0, (72, 600, 86, 614), out)} (empty box is {BASELINE_CHECKBOX_INK})")
    # The text field is the control: its value must show as ink in every variant, or the render check itself is broken.
    print(f"  ink in the text field box: {ink_inside(0, (72, 640, 320, 664), out)}")

# ── Q4: does the high-level wrapper refuse the duplicate name? ────────────────────────────────────────────────────
from pikepdf import form as pdfform  # noqa: E402

try:
    with pikepdf.Pdf.open(PDF) as pdf:
        form = pdfform.Form(pdf)
        print("\nForm wrapper accepted the document:", [type(f).__name__ for f in form])
except Exception as error:  # noqa: BLE001 — the point of the probe
    print(f"\nForm wrapper refused: {type(error).__name__}: {error}")
