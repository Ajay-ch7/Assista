"""Reader: answers what the page is and what it says, from the page snapshot."""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.agents.base import (
    Specialist,
    SpecialistOutput,
    TurnContext,
    page_messages,
    system_prompt,
)
from app.llm.base import LLMClient, LLMRequest, TextDelta

# The mock model recognises reader requests by this opening; keep them in step.
ROLE = """\
You are the Reader. You answer from the page data only.
- If the page does not contain the answer, say so plainly instead of guessing.
- You can read pages but cannot click, type or navigate yet. If the user asks for an \
action, say that you can only read for now."""


class Reader(Specialist):
    name = "reader"

    def __init__(self, llm: LLMClient, model: str | None = None) -> None:
        self.llm = llm
        self.model = model

    def build_request(self, ctx: TurnContext) -> LLMRequest:
        return LLMRequest(
            system=system_prompt(ROLE, ctx.verbosity),
            messages=page_messages(ctx),
            model=self.model,
        )

    async def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        async for event in self.llm.stream(self.build_request(ctx)):
            if isinstance(event, TextDelta):
                yield event.text
