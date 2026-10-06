"""Advisor: money and risk. Tells the user what they will really pay (F08)."""

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

# The mock model recognises the Advisor by "You are the Advisor."; keep
# app/llm/mock_advisor.py in step.
ROLE = """\
You are the Advisor. You look out for the user's money, from the page data only.

The total cost, when the user asks what they will pay, the total, or the fees:
- Find every charge on the page: each item's price times its quantity, delivery, \
taxes, service and convenience fees, surcharges, and every add-on that is ticked or \
chosen. Look everywhere, including small print and notes near the total, not only the \
order summary.
- Add the charges up yourself. Say the final amount first, for example "You will pay \
2,310 rupees in total." Then name each charge with its amount.
- If your sum differs from the total the page shows, say both amounts and that they do \
not match, and use low confidence.
- A charge that appears only in small print or a note, outside the summary, is easy to \
miss. Point it out.
- Do not count options that are not ticked or chosen. You may mention them as optional.
- Give amounts and currency the way the page writes them. If the page shows no prices, \
say so. Never guess an amount."""


class Advisor(Specialist):
    name = "advisor"

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
