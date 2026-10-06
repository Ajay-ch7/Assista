"""Reader for PDFs (F12): the headline, a skim, answers to questions, or the full text
read aloud a part at a time.

The extension fetches the file, because the backend lacks the user's login; the text is
extracted here. Full reading is done in code, word for word, so nothing is paraphrased.
Scanned pages have no text and are reported, not read.
"""

from __future__ import annotations

import asyncio
import dataclasses
import re
from collections.abc import AsyncIterator

from app.agents.base import (
    OpenDocument,
    Specialist,
    SpecialistOutput,
    TurnContext,
    page_messages,
    system_prompt,
)
from app.documents.pdf import MAX_PAGES, Document, DocumentError, extract
from app.errors import TurnError
from app.llm.base import LLMClient, LLMRequest, TextDelta
from app.protocol import PageSnapshot, SnapshotFlags, SnapshotNode

CHUNK = 1500
"""Characters read aloud per turn before the user is asked to say continue."""
MAX_PROMPT_TEXT = 60_000
"""Characters of the document given to the model."""
MAX_PARAGRAPH = 2000

# The mock model recognises the Reader by this opening; keep it.
ROLE = """\
You are the Reader. The user's tab shows a PDF document. Its text is in the page data: a \
heading for each page, then that page's text.

- Headline: say what the document is and its single most important point, in one or \
two sentences.
- Skim: give the title, then one sentence for each section in order, or for each page \
when there are no sections, and say which page each starts on.
- A question: answer from the document only, quote names, numbers and dates exactly, \
and say which page the answer is on. If the document does not say, say so plainly.
- Never read the whole text out yourself. If the user wants to hear it word for word, \
tell them to say "read it all" or "read page" and a number."""

HEADLINE_NOTE = "The user wants the headline of this document."
SKIM_NOTE = "The user wants to skim this document."

SCANNED_ALL = (
    "This PDF is made of scanned pictures of pages, with no text in it, and I can't read "
    "scanned documents yet."
)

_PAGE = re.compile(r"\bread (?:me )?page (\d+)\b", re.IGNORECASE)
_CONTINUE = re.compile(
    r"^(continue|go on|keep (reading|going)|read on|carry on)\b|^(next( part| page)?|more)\W*$",
    re.IGNORECASE,
)
_FULL = re.compile(
    r"\bread\b.*\b(whole|full|entire|everything|all of it|it all|aloud|out loud|word for "
    r"word|from the (start|beginning|top))\b|^read (it|this|the (document|pdf|file))\W*$",
    re.IGNORECASE,
)
_HEADLINE = re.compile(
    r"\b(headline|gist|in a (sentence|nutshell)|what('s| is) (it|this)( about)?|where am i|"
    r"what('s| is) this (document|pdf|file|page))\b",
    re.IGNORECASE,
)
_SKIM = re.compile(r"\b(skim|summar\w+|overview|main points|key points|outline)\b", re.I)


class DocumentReader(Specialist):
    name = "reader"

    def __init__(self, llm: LLMClient, model: str | None = None) -> None:
        self.llm = llm
        self.model = model

    async def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        opened = await open_document(ctx)
        document = opened.document
        if not document.readable:
            yield f"CONFIDENCE: high\n{SCANNED_ALL}"
            return

        if page := _PAGE.search(ctx.text):
            number = int(page.group(1))
            if not 1 <= number <= len(document.pages):
                yield f"CONFIDENCE: high\nThis document has {document.page_count} pages."
                return
            yield f"CONFIDENCE: high\n{read_aloud(opened, start=number - 1)}"
            return
        if _CONTINUE.search(ctx.text.strip()):
            yield f"CONFIDENCE: high\n{read_aloud(opened)}"
            return
        if _FULL.search(ctx.text.strip()):
            yield f"CONFIDENCE: high\n{read_aloud(opened, start=0)}"
            return

        note = ""
        if _HEADLINE.search(ctx.text):
            note = HEADLINE_NOTE
        elif _SKIM.search(ctx.text):
            note = SKIM_NOTE
        doc_ctx = dataclasses.replace(ctx, snapshot=document_snapshot(document))
        about = describe(document)
        request = LLMRequest(
            system=system_prompt(ROLE, ctx.verbosity),
            messages=page_messages(doc_ctx, f"{about}\n{note}".strip()),
            model=self.model,
        )
        async for event in self.llm.stream(request):
            if isinstance(event, TextDelta):
                yield event.text


async def open_document(ctx: TurnContext) -> OpenDocument:
    """The PDF on show, from memory when it was read before, else fetched and extracted."""
    url = ctx.snapshot.url
    cached = ctx.memory.document
    if cached is not None and cached.document.url == url:
        return cached
    file = await ctx.page.document()
    try:
        document = await asyncio.to_thread(extract, file.data, url, ctx.snapshot.title)
    except DocumentError as error:
        raise TurnError(f"document_{error.code}", error.reason) from error
    ctx.memory.document = OpenDocument(document)
    return ctx.memory.document


async def document_context(ctx: TurnContext) -> TurnContext:
    """The turn with the document's text in place of the empty PDF snapshot, so another
    specialist, such as the Advisor, can read it."""
    document = (await open_document(ctx)).document
    if not document.readable:
        raise TurnError("document_scanned", SCANNED_ALL)
    return dataclasses.replace(ctx, snapshot=document_snapshot(document))


def describe(document: Document) -> str:
    """Facts about the file for the model, in Assista's words."""
    facts = [f"This is a PDF document of {document.page_count} pages."]
    if scanned := document.scanned:
        pages = ", ".join(str(number) for number in scanned)
        facts.append(f"Pages {pages} are scanned pictures with no text, so they are missing.")
    if document.page_count > len(document.pages):
        facts.append(f"Only the first {len(document.pages)} pages were read.")
    if sum(len(page) for page in document.pages) > MAX_PROMPT_TEXT:
        facts.append("The text is long and was cut; later pages may be missing.")
    return " ".join(facts)


def document_snapshot(document: Document) -> PageSnapshot:
    """The document as page data: a heading per page, then its paragraphs."""
    nodes: list[SnapshotNode] = []
    budget = MAX_PROMPT_TEXT
    for number, text in enumerate(document.pages, start=1):
        if budget <= 0:
            break
        if not text:
            continue
        nodes.append(_node(nodes, "heading", name=f"Page {number}"))
        for paragraph in re.split(r"\n\s*\n", text):
            paragraph = " ".join(paragraph.split())
            while paragraph and budget > 0:
                piece = paragraph[: min(MAX_PARAGRAPH, budget)]
                paragraph = paragraph[len(piece) :]
                budget -= len(piece)
                nodes.append(_node(nodes, "paragraph", text=piece))
    return PageSnapshot(
        url=document.url,
        title=document.title,
        snapshot_id="document",
        nodes=nodes,
        flags=SnapshotFlags(pdf=True),
    )


def _node(nodes: list[SnapshotNode], role: str, name: str = "", text: str = "") -> SnapshotNode:
    return SnapshotNode(ref=f"d{len(nodes) + 1}", role=role, name=name, text=text)


def read_aloud(opened: OpenDocument, start: int | None = None) -> str:
    """The next part of the document, word for word, from page index `start` or from
    where reading stopped. Moves the reading position on."""
    if start is not None:
        opened.page, opened.offset = start, 0
    pages = opened.document.pages
    pieces: list[str] = []
    budget = CHUNK
    while budget > 0 and opened.page < len(pages):
        number, text = opened.page + 1, pages[opened.page]
        if opened.offset == 0:
            if not text:
                pieces.append(f"Page {number} is a scanned picture, and I can't read it.")
                opened.page += 1
                continue
            pieces.append(f"Page {number}.")
        rest = text[opened.offset :]
        if len(rest) <= budget:
            pieces.append(_spoken(rest))
            budget -= len(rest)
            opened.page, opened.offset = opened.page + 1, 0
        else:
            cut = _cut(rest, budget)
            pieces.append(_spoken(rest[:cut]))
            opened.offset += cut
            budget = 0
    if opened.page < len(pages):
        pieces.append("Say continue to hear more.")
    else:
        pieces.append("That is the end of the document.")
        if opened.document.page_count > len(pages):
            pieces.append(f"I read only the first {MAX_PAGES} pages.")
    return "\n".join(pieces)


def _cut(text: str, budget: int) -> int:
    """Where to stop: after the last sentence that fits, else at a space."""
    window = text[:budget]
    ends = [match.end() for match in re.finditer(r"[.!?](\s|$)", window)]
    if ends and ends[-1] > budget // 3:
        return ends[-1]
    space = window.rfind(" ")
    return space + 1 if space > 0 else budget


def _spoken(text: str) -> str:
    """Lines without end punctuation, such as headings, become sentences of their own."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return " ".join(line if line[-1] in ".!?:;," else f"{line}." for line in lines)
