"""Stand-in model for tests. It needs no key and makes no network calls."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Sequence

from app.llm.base import LLMClient, LLMEvent, LLMRequest, Message, StreamEnd, TextDelta

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*)\n</page_data_\w+>", re.DOTALL)


class MockLLM(LLMClient):
    """Replays scripted replies; without a script, describes the page data it was given.

    Every request is kept in `requests`, so a test can check what the model was sent.
    """

    def __init__(self, script: Sequence[Sequence[LLMEvent]] = ()) -> None:
        self._script = list(script)
        self.requests: list[LLMRequest] = []

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]:
        self.requests.append(request)
        if self._script:
            for event in self._script.pop(0):
                yield event
            return
        # In small pieces, the way a real model streams.
        for word in re.findall(r"\S+\s*", _describe(request.messages)):
            yield TextDelta(word)
        yield StreamEnd()


def _last_user_text(messages: Sequence[Message]) -> str:
    for message in reversed(messages):
        if message.role == "user":
            if isinstance(message.content, str):
                return message.content
            return " ".join(getattr(part, "text", "") for part in message.content)
    return ""


def _describe(messages: Sequence[Message]) -> str:
    match = _PAGE_DATA.search(_last_user_text(messages))
    if not match:
        return "I have no page to look at."
    page = json.loads(match.group(1))
    nodes = page.get("nodes", [])

    def count(*roles: str) -> int:
        return sum(1 for node in nodes if node.get("role") in roles)

    heading = next((n.get("name") for n in nodes if n.get("role") == "heading"), None)
    sentences = [f"This page is titled {page.get('title') or 'untitled'}."]
    if heading:
        sentences.append(f"Its main heading is {heading}.")
    sentences.append(
        f"It has {count('link')} links, {count('button')} buttons and "
        f"{count('textbox', 'searchbox', 'combobox', 'checkbox', 'radio')} form fields."
    )
    return " ".join(sentences)
