"""Writes demo-pages/guide.pdf, the PDF the document-reading tests open.

The file is built by hand, with no PDF library, so it can be remade anywhere:
    uv run python scripts/make_demo_pdf.py
"""

from __future__ import annotations

from pathlib import Path

TITLE = "Riverside Outfitters Returns and Warranty Guide"

PAGES = [
    [
        ("h", "Returns and Warranty Guide"),
        ("p", "Riverside Outfitters, edition of August 2026."),
        ("h", "Returning an item"),
        ("p", "You can return any unused item within 30 days of delivery."),
        ("p", "Pack it in its original box and book a free pickup from your orders page."),
        ("p", "Refunds reach your card within 7 working days of the pickup."),
        ("h", "Items we cannot take back"),
        ("p", "Gas canisters, opened food and personalised items cannot be returned."),
    ],
    [
        ("h", "Warranty"),
        ("p", "Backpacks and tents carry a two-year warranty against faults in making."),
        ("p", "The warranty does not cover wear and tear, or damage from misuse."),
        ("h", "Making a claim"),
        ("p", "Email a photo of the fault and your order number to care@riverside.example."),
        ("p", "We repair or replace the item within 21 days of receiving it."),
    ],
]


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _content(lines: list[tuple[str, str]]) -> bytes:
    ops = ["BT", "72 770 Td"]
    for kind, text in lines:
        size, gap = (16, 30) if kind == "h" else (11, 18)
        ops.append(f"/F1 {size} Tf 0 -{gap} Td ({_escape(text)}) Tj")
    ops.append("ET")
    return "\n".join(ops).encode("latin-1")


def build() -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # Filled in once the page tree exists.
    pages = add(b"")
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    kids = []
    for lines in PAGES:
        stream = _content(lines)
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        kids.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] "
                b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                % (pages, font, content)
            )
        )
    objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages
    refs = " ".join(f"{kid} 0 R" for kid in kids).encode()
    objects[pages - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (refs, len(kids))
    info = add(b"<< /Title (%s) >>" % _escape(TITLE).encode("latin-1"))

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\n" % (
        len(objects) + 1,
        catalog,
        info,
    )
    out += b"startxref\n%d\n%%%%EOF\n" % xref
    return bytes(out)


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "demo-pages" / "guide.pdf"
    target.write_bytes(build())
    print(f"wrote {target}")
