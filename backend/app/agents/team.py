"""The router and its specialists, run as one responder."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from app.agents.base import (
    ConfidenceFilter,
    Specialist,
    SpecialistOutput,
    SpecialistResponse,
    TurnContext,
)
from app.agents.reader import Reader
from app.agents.router import SpecialistName, route
from app.llm.base import LLMClient

log = logging.getLogger("assista.team")


class NotYet(Specialist):
    """Stands in for a specialist that a later phase builds."""

    def __init__(self, name: str, reply: str) -> None:
        self.name = name  # type: ignore[misc]
        self.reply = reply

    async def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        yield f"CONFIDENCE: high\n{self.reply}"


class Team:
    def __init__(
        self, llm: LLMClient, model: str | None = None, router_model: str | None = None
    ) -> None:
        self.llm = llm
        self.router_model = router_model
        reader = Reader(llm, model)
        self.specialists: dict[SpecialistName, Specialist] = {
            "reader": reader,
            # Costs, fees and fine print are read from the page until the Advisor exists.
            "advisor": reader,
            # The Vision specialist replaces this in P2.5.
            "vision": NotYet(
                "vision", "I can't look at images yet, but I can read you the page's text."
            ),
            "actor": NotYet(
                "actor",
                "I can read pages and describe what is on them, but I can't click, type "
                "or move between pages yet.",
            ),
            "watcher": NotYet("watcher", "I can't watch pages for changes yet."),
        }

    def pick(self, name: SpecialistName, ctx: TurnContext) -> Specialist:
        return self.specialists[name]

    async def respond(self, ctx: TurnContext) -> AsyncIterator[str]:
        name = await route(self.llm, ctx.text, ctx.memory, self.router_model)
        specialist = self.pick(name, ctx)
        log.info("routed to %s, handled by %s", name, specialist.name)
        async for piece in run_specialist(specialist, ctx):
            yield piece


async def run_specialist(specialist: Specialist, ctx: TurnContext) -> AsyncIterator[str]:
    """Streams a specialist's speech without its confidence line, then records the turn."""
    out = SpecialistOutput()
    confidence = ConfidenceFilter()
    spoken: list[str] = []
    async for piece in specialist.respond(ctx, out):
        if speech := confidence.feed(piece):
            spoken.append(speech)
            yield speech
    if rest := confidence.flush():
        spoken.append(rest)
        yield rest

    response = SpecialistResponse(
        speech="".join(spoken).strip(),
        confidence=confidence.confidence or "medium",
        tool_calls=out.tool_calls,
        follow_up_context=out.follow_up_context,
    )
    ctx.memory.remember(ctx.text, specialist.name, response)
