"""The router and its specialists, run as one responder."""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator

from app.agents.actor import Actor
from app.agents.advisor import Advisor
from app.agents.base import (
    ConfidenceFilter,
    Specialist,
    SpecialistOutput,
    SpecialistResponse,
    TurnContext,
)
from app.agents.document import DocumentReader, document_context
from app.agents.reader import Reader
from app.agents.router import SpecialistName, route
from app.agents.vision import PageVision, Vision
from app.agents.watcher import Watcher
from app.errors import PAGE_UNREADABLE, TurnError
from app.llm.base import LLMClient

log = logging.getLogger("assista.team")


class Team:
    def __init__(
        self, llm: LLMClient, model: str | None = None, router_model: str | None = None
    ) -> None:
        self.llm = llm
        self.router_model = router_model
        reader = Reader(llm, model)
        self.page_vision = PageVision(llm, model)
        self.document_reader = DocumentReader(llm, model)
        self.specialists: dict[SpecialistName, Specialist] = {
            "reader": reader,
            "advisor": Advisor(llm, model),
            "vision": Vision(llm, model),
            "actor": Actor(llm, model),
            "watcher": Watcher(llm, model),
        }

    def pick(self, name: SpecialistName, ctx: TurnContext) -> Specialist:
        specialist = self.specialists[name]
        # A PDF has no page to read: its file is fetched and read instead.
        if name == "reader" and ctx.snapshot.flags.pdf:
            return self.document_reader
        # A page the snapshot cannot describe is read from a screenshot as well, unless
        # private mode keeps pictures of the screen on the device.
        # A question about a table is answered from the table, even on a page that is thin
        # because of a chart.
        if specialist is self.specialists["reader"]:
            if ctx.snapshot.flags.thin and not ctx.private_mode and not _about_table(ctx):
                return self.page_vision
        return specialist

    async def respond(self, ctx: TurnContext) -> AsyncIterator[str]:
        if ctx.confirmed is not None:
            # The user's yes to a held action: the Actor reports what happened.
            specialist = self.specialists["actor"]
        else:
            name = await route(self.llm, ctx.text, ctx.memory, self.router_model)
            specialist = self.pick(name, ctx)
            log.info("routed to %s, handled by %s", name, specialist.name)
            if ctx.snapshot.flags.unreadable and name != "actor":
                raise TurnError("page_unreadable", PAGE_UNREADABLE)
            if name == "advisor" and ctx.snapshot.flags.pdf:
                # Terms and prices in a PDF are judged from its text.
                ctx = await document_context(ctx)
        async for piece in run_specialist(specialist, ctx):
            yield piece


_TABLE_WORDS = re.compile(r"\b(tables?|rows?|columns?)\b", re.IGNORECASE)


def _about_table(ctx: TurnContext) -> bool:
    return bool(ctx.snapshot.tables) and bool(_TABLE_WORDS.search(ctx.text))


UNSURE_BEFORE = "I'm not sure about this.\n"
UNSURE_AFTER = "\nI'm not sure about that, so please check it."


async def run_specialist(specialist: Specialist, ctx: TurnContext) -> AsyncIterator[str]:
    """Streams a specialist's speech without its confidence line, then records the turn.

    Low confidence is always spoken (F11): before the answer when the specialist says so
    up front, otherwise after it.
    """
    out = SpecialistOutput()
    confidence = ConfidenceFilter()
    spoken: list[str] = []
    started = warned = False

    def speak(speech: str) -> list[str]:
        nonlocal started, warned
        pieces = []
        if not started and speech.strip():
            started = True
            if confidence.confidence == "low":
                warned = True
                pieces.append(UNSURE_BEFORE)
        pieces.append(speech)
        spoken.extend(pieces)
        return pieces

    async for piece in specialist.respond(ctx, out):
        for speech in speak(confidence.feed(piece)):
            yield speech
    for speech in speak(confidence.flush()):
        yield speech
    if confidence.confidence == "low" and not warned:
        spoken.append(UNSURE_AFTER)
        yield UNSURE_AFTER

    response = SpecialistResponse(
        speech="".join(spoken).strip(),
        confidence=confidence.confidence or "medium",
        tool_calls=out.tool_calls,
        follow_up_context=out.follow_up_context,
    )
    ctx.memory.remember(ctx.text, specialist.name, response)
