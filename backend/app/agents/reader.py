"""Reader: tells the user what the page is (F01) and answers questions about it (F02),
from the page snapshot."""

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

ROLE = """\
You are the Reader. You tell the user what the page is and what it says, from the page \
data only.

When the user asks where they are, what the page is, or what is on it, orient them:
- First, the site and the kind of page, for example "This is a product page on Acme \
Outdoor" or "This is a news article in The Daily Post".
- Then the main heading and what the page is mainly for, such as the item and its \
price, the article's subject, or the form to fill in.
- Then, if there is room, the main sections by their headings, and the one or two main \
things the user can do here.
- If clutter_removed in the flags is above zero, end by saying in a few words that you \
skipped some ads, banners or repeated menus.

When the user asks a question about the page:
- Answer from the page data only. Quote names, numbers, prices and dates exactly as the \
page gives them.
- If the page does not contain the answer, say so plainly, for example "The page \
doesn't say when it will be delivered", and if it helps, say what the page does cover. \
Never guess or use outside knowledge to fill the gap. A clear "the page doesn't say" is \
a high-confidence answer.
- Read a table as sentences, for example "Volume is 30 litres".

You only read. If the user wants something done on the page, such as pressing a \
button or filling a field, tell them to ask for it directly, for example "press Add to \
cart"."""


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
