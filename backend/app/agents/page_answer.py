"""Phase 1 agent: one prompt that answers a spoken request from the page snapshot.

Phase 2 replaces this with the router and the Reader.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.llm.base import LLMClient, LLMRequest, Message, TextDelta
from app.llm.page_data import PAGE_DATA_RULES, wrap_page_data
from app.protocol import PageSnapshot, Verbosity

_VERBOSITY: dict[str, str] = {
    "brief": "Answer in one or two short sentences.",
    "normal": "Answer in two to four sentences.",
    "detailed": "Give a fuller answer of up to eight sentences, most important things first.",
}

_SYSTEM = """\
You are Assista, a voice assistant that helps blind, low-vision and motor-impaired people \
use the web. The user cannot see the screen. Everything you write is turned into speech \
and played aloud.

How to answer:
- Write plain spoken English in full sentences. No markdown, lists, headings, emoji or \
symbols, and do not read out web addresses.
- Never say reference ids such as e12. Name things the way the page does, for example \
"the Add to cart button".
- Start with the answer itself. {verbosity}
- Answer only from the page data. If the page does not contain the answer, say so \
plainly instead of guessing.
- Fields marked sensitive have their values withheld on purpose. Never ask the user to \
say a password, code, card number or PIN aloud.
- You can read pages but cannot click, type or navigate yet. If the user asks for an \
action, say that you can only read for now.

Page data:
{page_data_rules}"""


def build_request(
    text: str, snapshot: PageSnapshot, verbosity: Verbosity, model: str | None = None
) -> LLMRequest:
    system = _SYSTEM.format(verbosity=_VERBOSITY[verbosity], page_data_rules=PAGE_DATA_RULES)
    # Page content goes in the user message as a data block, never in the system prompt.
    user = f"{wrap_page_data(snapshot)}\n\nThe user's spoken request: {text}"
    return LLMRequest(system=system, messages=[Message("user", user)], model=model)


async def answer_from_page(
    llm: LLMClient,
    text: str,
    snapshot: PageSnapshot,
    verbosity: Verbosity = "normal",
    model: str | None = None,
) -> AsyncIterator[str]:
    """Streams the spoken answer as text pieces."""
    async for event in llm.stream(build_request(text, snapshot, verbosity, model)):
        if isinstance(event, TextDelta):
            yield event.text
