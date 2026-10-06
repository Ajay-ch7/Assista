"""Document reading (F12): the extension sends the PDF on show; its text is extracted
here and read as a headline, a skim, answers, or word for word, in text mode."""

import io
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

from app.agents import document as document_module
from app.agents.document import HEADLINE_NOTE, SCANNED_ALL, SKIM_NOTE
from app.config import Settings
from app.documents.pdf import DocumentError, extract
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from tests.harness import SHOP_SNAPSHOT, session

GUIDE = (Path(__file__).resolve().parents[2] / "demo-pages" / "guide.pdf").read_bytes()

PDF_SNAPSHOT = {
    "url": "http://127.0.0.1:8787/guide.pdf",
    "title": "guide.pdf",
    "snapshot_id": "pdf0123456789abcdef",
    "flags": {"pdf": True},
}


def session_with(llm: MockLLM):
    config = Settings()
    return session(Deps(settings=config, respond=model_responder(config, llm)))


def with_blank_page(data: bytes) -> bytes:
    """The guide with a third page that has no text, as a scanned page has none."""
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(data)).pages:
        writer.add_page(page)
    writer.add_blank_page(width=595, height=842)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def blank_pdf(pages: int = 2) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


# Extraction


def test_the_text_of_each_page_is_extracted_with_the_title():
    document = extract(GUIDE, "http://x/guide.pdf", "fallback")
    assert document.title == "Riverside Outfitters Returns and Warranty Guide"
    assert document.page_count == 2
    assert document.pages[0].startswith("Returns and Warranty Guide\n")
    assert "two-year warranty" in document.pages[1]
    assert document.scanned == []
    assert document.readable


def test_pages_without_text_are_marked_as_scanned():
    document = extract(with_blank_page(GUIDE))
    assert document.scanned == [3]
    assert document.readable
    assert not extract(blank_pdf(), fallback_title="scan.pdf").readable


def test_a_file_that_is_not_a_pdf_cannot_be_read():
    with pytest.raises(DocumentError) as error:
        extract(b"%PDF-1.4 this is not really a pdf")
    assert error.value.code == "unreadable"
    assert "damaged" in error.value.reason


def test_a_password_protected_pdf_cannot_be_read():
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)
    writer.encrypt(user_password="secret", owner_password="owner")
    out = io.BytesIO()
    writer.write(out)
    with pytest.raises(DocumentError) as error:
        extract(out.getvalue())
    assert error.value.code == "encrypted"


# In a session


def test_the_headline_asks_for_the_file_and_reads_its_text_as_data():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("what is this document?", snapshot=PDF_SNAPSHOT, document=GUIDE)
    assert result.types[:3] == ["transcript_final", "request_snapshot", "request_document"]
    (request,) = llm.specialist_requests
    assert "The user's tab shows a PDF document" in request.system
    content = request.messages[-1].content
    assert content.startswith("<page_data_")
    block_end = content.index("</page_data_")
    assert "Refunds reach your card within 7 working days" in content[:block_end]
    assert "This is a PDF document of 2 pages." in content[block_end:]
    assert HEADLINE_NOTE in content[block_end:]
    assert "7 working days" not in request.system
    assert result.speech[0] == (
        "This page is titled Riverside Outfitters Returns and Warranty Guide."
    )


def test_skimming_and_questions_get_their_own_notes():
    llm = MockLLM()
    with session_with(llm) as client:
        client.ask("give me a summary", snapshot=PDF_SNAPSHOT, document=GUIDE)
        result = client.ask("how long is the warranty?", snapshot=PDF_SNAPSHOT)
    skim, question = llm.specialist_requests
    assert SKIM_NOTE in skim.messages[-1].content
    assert HEADLINE_NOTE not in question.messages[-1].content
    # The mock answers with the first stretch of text that shares a word with the question.
    assert result.speech[0].startswith("The page says: ")


def test_the_file_is_fetched_once_for_follow_ups_on_the_same_document():
    with session_with(MockLLM()) as client:
        first = client.ask("what is this document?", snapshot=PDF_SNAPSHOT, document=GUIDE)
        second = client.ask("how long is the warranty?", snapshot=PDF_SNAPSHOT)
    assert first.types.count("request_document") == 1
    assert "request_document" not in second.types


def test_reading_it_all_speaks_the_text_word_for_word():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("read it all to me", snapshot=PDF_SNAPSHOT, document=GUIDE)
    assert llm.specialist_requests == []
    assert result.speech[:4] == [
        "Page 1.",
        "Returns and Warranty Guide.",
        "Riverside Outfitters, edition of August 2026.",
        "Returning an item.",
    ]
    assert "Page 2." in result.speech
    assert result.speech[-1] == "That is the end of the document."


def test_a_long_document_is_read_a_part_at_a_time_with_continue(monkeypatch):
    monkeypatch.setattr(document_module, "CHUNK", 200)
    with session_with(MockLLM()) as client:
        first = client.ask("read the whole document", snapshot=PDF_SNAPSHOT, document=GUIDE)
        second = client.ask("continue", snapshot=PDF_SNAPSHOT)
        rest = [client.ask("continue", snapshot=PDF_SNAPSHOT) for _ in range(4)]
    assert first.speech[0] == "Page 1."
    assert first.speech[-1] == "Say continue to hear more."
    assert second.speech[0] != "Page 1."
    heard = " ".join(first.speech + second.speech + [s for r in rest for s in r.speech])
    for line in ("free pickup from your orders page.", "two-year warranty", "within 21 days"):
        assert line in heard
    assert "That is the end of the document." in heard


def test_a_page_can_be_read_by_its_number():
    with session_with(MockLLM()) as client:
        result = client.ask("read page 2", snapshot=PDF_SNAPSHOT, document=GUIDE)
        missing = client.ask("read page 9", snapshot=PDF_SNAPSHOT)
    assert result.speech[:2] == ["Page 2.", "Warranty."]
    assert missing.speech == ["This document has 2 pages."]


def test_scanned_pages_are_reported_not_read():
    scanned = with_blank_page(GUIDE)
    with session_with(MockLLM()) as client:
        result = client.ask("read page 3", snapshot=PDF_SNAPSHOT, document=scanned)
    assert result.speech[0] == "Page 3 is a scanned picture, and I can't read it."
    llm = MockLLM()
    with session_with(llm) as client:
        client.ask("what is this document?", snapshot=PDF_SNAPSHOT, document=scanned)
    assert (
        "Pages 3 are scanned pictures with no text"
        in llm.specialist_requests[0].messages[-1].content
    )


def test_a_scanned_document_says_it_cannot_be_read():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("what is this?", snapshot=PDF_SNAPSHOT, document=blank_pdf())
    assert " ".join(result.speech) == SCANNED_ALL
    assert llm.specialist_requests == []


@pytest.mark.parametrize(
    ("reply", "message"),
    [
        ({"data": None, "error": "too_large"}, "This PDF is too big for me to read."),
        ({"data": None, "error": "fetch_failed: 403"}, "I could not download this PDF."),
        ({"data": "not base64!"}, "I could not open this PDF."),
    ],
)
def test_a_document_that_cannot_be_had_ends_in_a_spoken_error(reply, message):
    with session_with(MockLLM()) as client:
        result = client.ask("what is this document?", snapshot=PDF_SNAPSHOT, document=reply)
    assert result.error["message"].startswith(message)


def test_a_damaged_pdf_ends_in_a_spoken_error():
    with session_with(MockLLM()) as client:
        result = client.ask("what is this?", snapshot=PDF_SNAPSHOT, document=b"%PDF-1.4 junk")
    assert result.error["code"] == "document_unreadable"


def test_the_advisor_reads_the_fine_print_of_a_pdf():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("any red flags in the terms?", snapshot=PDF_SNAPSHOT, document=GUIDE)
    (request,) = llm.specialist_requests
    assert "You are the Advisor." in request.system
    assert "Refunds reach your card" in request.messages[-1].content
    assert result.types[-1] == "done"


def test_ordinary_pages_never_ask_for_a_document():
    with session_with(MockLLM()) as client:
        result = client.ask("what is this page?", snapshot=SHOP_SNAPSHOT)
    assert "request_document" not in result.types
