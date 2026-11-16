"""Probe 4 — the corrected order, and the four facts the handler still needs.

    docker exec -i pdf-tools-worker-heavy-1 python3 - < scripts/dev/probe-redact.py

Probe 3 isolated the trap this file now walks around: adding a `/Redact` annotation and *then* scrubbing
annotations that overlap the region deletes the redaction itself, so `apply_redactions` applies nothing, the page is
saved unchanged, and only an assertion that reads the page back can tell. Order is therefore
**scrub → mark → apply**, and no `/Redact` annotation is ever a scrub candidate.

What this probe settles: that the removal survives the corrected order; that poppler limited to the region is empty
afterwards (the verification the handler is built on); what `removeContent: false` must do to paint a box while
removing nothing; that a duplicate token elsewhere on the page survives; and that the box is actually black ink.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import zlib

import pymupdf

OUT = "/tmp/probe-redact4"
os.makedirs(OUT, exist_ok=True)
PAGE = (595.0, 842.0)
SECRET = "ACCT-4471-9930"
PUBLIC = "PUBLIC-KEEP-0001"
DUPLICATE = "SHARED-7731"

report: dict = {}


def build(path: str) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE[0], height=PAGE[1])
    page.insert_text((72, 600), f"Account {SECRET} belongs to Nadia", fontsize=12)
    page.insert_text((72, 550), f"Reference {PUBLIC} stays", fontsize=12)
    page.insert_text((72, 300), f"{DUPLICATE} appears here too", fontsize=12)
    page.insert_text((72, 200), f"{DUPLICATE} in the surviving copy", fontsize=12)
    page.draw_line(pymupdf.Point(60, 700), pymupdf.Point(500, 700), width=1)
    doc.set_metadata({"title": "Redaction probe", "subject": "DOCINFO-SECRET", "keywords": SECRET})
    doc.embfile_add("secret-attachment.txt", b"PAYLOAD-REDACT-ATTACHMENT", filename="secret-attachment.txt")
    doc.save(path, garbage=4, deflate=True)
    doc.close()


FIXTURE = os.path.join(OUT, "probe.pdf")
build(FIXTURE)

# Contract rects are PDF user space with a lower-left origin (as `annotate`'s and `sign`'s are), so the flip to
# PyMuPDF's upper-left origin happens here once.
REGION = {"x": 66.0, "y": PAGE[1] - 614, "w": 334.0, "h": 26.0}
DUPLICATE_REGION = {"x": 66.0, "y": PAGE[1] - 312, "w": 400.0, "h": 26.0}


def rect_of(region) -> pymupdf.Rect:
    return pymupdf.Rect(
        region["x"], PAGE[1] - (region["y"] + region["h"]), region["x"] + region["w"], PAGE[1] - region["y"]
    )


def poppler_rect(path: str, page: int, region, dpi: int = 72) -> str:
    scale = dpi / 72.0
    top = PAGE[1] - (region["y"] + region["h"])
    cmd = [
        "pdftotext", "-f", str(page), "-l", str(page),
        "-x", str(int(round(region["x"] * scale))), "-y", str(int(round(top * scale))),
        "-W", str(int(round(region["w"] * scale))), "-H", str(int(round(region["h"] * scale))),
        "-r", str(dpi), path, "-",
    ]
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def byte_search(path: str, token: str) -> dict:
    data = open(path, "rb").read()
    inflated = bytearray()
    for match in re.finditer(rb"stream\r?\n", data):
        start = match.end()
        end = data.find(b"endstream", start)
        if end == -1:
            continue
        try:
            inflated += zlib.decompress(data[start:end].rstrip(b"\r\n"))
        except zlib.error:
            continue
    return {"raw": token.encode() in data, "inflated": token.encode() in bytes(inflated)}


def ink(path: str, region, dpi: int = 72) -> float:
    """Share of pixels darker than 200/255 inside the region — the harness's own measure, at the same threshold."""
    subprocess.run(["pdftoppm", "-r", str(dpi), "-f", "1", "-l", "1", "-gray", "-png", path, os.path.join(OUT, "pg")], check=True)
    produced = sorted(
        name for name in os.listdir(OUT) if name.startswith("pg") and name.endswith(".png")
    )
    pixmap = pymupdf.Pixmap(os.path.join(OUT, produced[-1]))
    scale = dpi / 72.0
    x0 = int(region["x"] * scale)
    y0 = int((PAGE[1] - (region["y"] + region["h"])) * scale)
    x1 = int((region["x"] + region["w"]) * scale)
    y1 = int((PAGE[1] - region["y"]) * scale)
    dark = total = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if 0 <= x < pixmap.width and 0 <= y < pixmap.height:
                total += 1
                if pixmap.pixel(x, y)[0] < 200:
                    dark += 1
    return round(dark / total, 4) if total else 0.0


def redact(src: str, out: str, *, remove: bool, fill=(0, 0, 0), scrub_before: bool = True) -> dict:
    doc = pymupdf.open(src)
    page = doc[0]
    scrubbed = 0
    if scrub_before:
        # Never a scrub candidate: the redaction annotation this job is about to add. `str(annot.type)` is
        # "Redact"/"/Redact" depending on version, so the check is on the name rather than on the tuple.
        for annot in list(page.annots() or []):
            if "Redact" in str(annot.type):
                continue
            if annot.rect.intersects(rect_of(REGION)):
                page.delete_annot(annot)
                scrubbed += 1
    page.add_redact_annot(rect_of(REGION), fill=fill)
    if remove:
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_REMOVE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
            text=pymupdf.PDF_REDACT_TEXT_REMOVE,
        )
    else:
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_NONE,
            graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            text=pymupdf.PDF_REDACT_TEXT_NONE,
        )
    doc.save(out, garbage=4, deflate=True)
    doc.close()
    return {
        "scrubbed": scrubbed,
        "page_text": pymupdf.open(out)[0].get_text().strip().replace("\n", " | "),
        "poppler_region": poppler_rect(out, 1, REGION),
        "poppler_duplicate": poppler_rect(out, 1, DUPLICATE_REGION),
        "region_ink": ink(out, REGION),
        "secret_bytes": byte_search(out, SECRET),
        "public_bytes": byte_search(out, PUBLIC),
        "attachments": pymupdf.open(out).embfile_count(),
        "docinfo_subject": pymupdf.open(out).metadata.get("subject"),
    }


report["remove"] = redact(FIXTURE, os.path.join(OUT, "removed.pdf"), remove=True)
report["remove_red_fill"] = redact(FIXTURE, os.path.join(OUT, "removed-red.pdf"), remove=True, fill=(0.8, 0.1, 0.1))
report["overlay_only"] = redact(FIXTURE, os.path.join(OUT, "overlay.pdf"), remove=False)
report["overlay_only"]["text_still_in_region"] = "ACCT-4471-9930" in report["overlay_only"]["poppler_region"]

# The token filter the verification rests on: occurrences of a token inside the marked regions versus the whole
# document, so a token that legitimately survives elsewhere is not asserted against.
doc = pymupdf.open(FIXTURE)
whole = doc[0].get_text()
region_text = doc[0].get_text("text", clip=rect_of(REGION)) + doc[0].get_text("text", clip=rect_of(DUPLICATE_REGION))
doc.close()
tokens = sorted({token for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9._@/-]{3,}", region_text)})
report["token_filter"] = {
    "tokens_in_regions": tokens,
    "whole_document_counts": {token: whole.count(token) for token in tokens},
    "outside_occurrences": {
        token: whole.count(token) - region_text.count(token) for token in tokens
    },
}

print("PROBE4 " + json.dumps(report, indent=1, default=str))
