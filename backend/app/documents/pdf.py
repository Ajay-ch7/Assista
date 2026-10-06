"""PDF text extraction. Pages without a text layer are scanned pictures; they are marked,
not read, since scanned-document reading is not built."""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.errors import PdfReadError

log = logging.getLogger("assista.documents")

MAX_PAGES = 300
"""Pages read from one file. Longer documents are cut, and the user is told."""


@dataclass(frozen=True)
class Document:
    url: str
    title: str
    pages: list[str]
    """The text of each page read; an empty string for a scanned page."""
    page_count: int
    """Pages in the file, which may be more than were read."""

    @property
    def scanned(self) -> list[int]:
        """Page numbers, from 1, of the pages that have no text."""
        return [number for number, text in enumerate(self.pages, start=1) if not text]

    @property
    def readable(self) -> bool:
        return any(self.pages)


class DocumentError(Exception):
    """The file could not be read. `reason` is a sentence for the user."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def extract(data: bytes, url: str = "", fallback_title: str = "") -> Document:
    """Reads the text of each page. Raises DocumentError for a file it cannot open."""
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not _unlock(reader):
            raise DocumentError(
                "encrypted", "This PDF is locked with a password, so I can't read it."
            )
        pages = [_page_text(page) for page in reader.pages[:MAX_PAGES]]
        page_count = len(reader.pages)
        title = _title(reader) or fallback_title
    except DocumentError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, OSError) as error:
        log.info("unreadable PDF: %s", error)
        raise DocumentError(
            "unreadable", "This PDF seems to be damaged, so I can't read it."
        ) from error
    return Document(url=url, title=title, pages=pages, page_count=page_count)


def _unlock(reader: PdfReader) -> bool:
    # Many PDFs are encrypted with an empty password only to restrict printing.
    try:
        return bool(reader.decrypt(""))
    except Exception:
        return False


def _page_text(page) -> str:  # type: ignore[no-untyped-def]
    try:
        text = page.extract_text() or ""
    except Exception:
        log.info("could not extract a page", exc_info=True)
        return ""
    # Joins words hyphenated across lines, and tidies the spacing.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def _title(reader: PdfReader) -> str:
    try:
        title = reader.metadata.title if reader.metadata else None
    except Exception:
        return ""
    return str(title).strip() if title else ""
