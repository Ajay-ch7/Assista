"""Router: picks the one specialist that handles a request, with the small, fast model."""

from __future__ import annotations

import logging
import re
from typing import Literal

from app.agents.base import SessionMemory
from app.llm.base import LLMClient, LLMRequest, Message, collect_text

log = logging.getLogger("assista.router")

SpecialistName = Literal["reader", "vision", "actor", "advisor", "watcher"]
SPECIALISTS: tuple[SpecialistName, ...] = ("reader", "vision", "actor", "advisor", "watcher")
DEFAULT: SpecialistName = "reader"

# The mock model recognises router requests by this opening; keep them in step.
SYSTEM = """\
You route requests for Assista, a voice assistant for blind and low-vision people \
browsing the web. Pick the one specialist that should handle the user's request.

- reader: what the page is, where the user is, what it says, finding facts or answers \
on the page, reading sections, headings, links, lists and tables. Also reading PDF \
documents, including "continue" after part of one was read aloud.
- vision: anything about how something looks: images, photos, pictures, logos, colours, \
charts, graphs, diagrams, layout, or what is on the screen. Also follow-up questions \
about an image or picture that was just described.
- actor: doing something on the page or in the browser: click, press, follow a link, \
type, fill in a form, choose an option, scroll, go back, open a site, switch tabs, \
move to a field such as the search box, search the site, or search the web for a website.
- advisor: money and risk: the total cost and what the user will pay, fees, hidden \
charges, whether a deal is fair, tricks or dark patterns, fine print and terms.
- watcher: watching a page and telling the user later when something changes, such as a \
price drop or a seat opening.

Reply with the specialist's name only, one lowercase word."""


def build_request(text: str, memory: SessionMemory, model: str | None = None) -> LLMRequest:
    lines: list[str] = []
    if (last := memory.last) is not None:
        lines.append(f"Previous request (handled by {last.specialist}): {last.request}")
        lines.append(f"Previous answer: {last.reply}")
    lines.append(f"Request: {text}")
    return LLMRequest(system=SYSTEM, messages=[Message("user", "\n".join(lines))], model=model)


def parse(reply: str) -> SpecialistName | None:
    for word in re.findall(r"[a-z]+", reply.lower()):
        if word in SPECIALISTS:
            return word  # type: ignore[return-value]
    return None


async def route(
    llm: LLMClient, text: str, memory: SessionMemory, model: str | None = None
) -> SpecialistName:
    """Names the specialist for `text`. Any failure falls back to the reader."""
    try:
        reply = await collect_text(llm.stream(build_request(text, memory, model)))
    except Exception:
        log.exception("routing failed; using the %s", DEFAULT)
        return DEFAULT
    name = parse(reply)
    if name is None:
        log.warning("router reply %r names no specialist; using the %s", reply[:80], DEFAULT)
        return DEFAULT
    return name
