"""Stand-in model for tests. It needs no key and makes no network calls."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Sequence

from app.llm.base import LLMClient, LLMEvent, LLMRequest, Message, StreamEnd, TextDelta

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*)\n</page_data_\w+>", re.DOTALL)

# Router requests open with this (app/agents/router.py). The mock routes them by keyword.
_ROUTER_SYSTEM = "You route requests"
_ROUTES = [
    ("watcher", r"\b(watch|notify|tell me when|let me know when|alert me)\b"),
    (
        "vision",
        r"\b(image|images|photo|photos|picture|pictures|logo|chart|graph|looks? like|"
        r"colou?rs?|screen)\b",
    ),
    (
        "actor",
        r"\b(click|press|tap|type|fill|select|choose|scroll|go back|go to|open|switch|"
        r"add .+ to (the )?cart|sign in|log in)\b",
    ),
    ("advisor", r"\b(total|cost|fees?|charges?|hidden|trick|terms|fine print)\b"),
]
_FOLLOW_UP = re.compile(r"\b(it|its|it's|they|them|that one|this one|he|she|wearing)\b")


class MockLLM(LLMClient):
    """Replays scripted replies; without a script, describes the page data it was given.

    Router requests are always answered by keyword and never use the script, so a test's
    script holds only the specialists' replies. Every request is kept in `requests`, so a
    test can check what the model was sent.
    """

    def __init__(self, script: Sequence[Sequence[LLMEvent]] = ()) -> None:
        self._script = list(script)
        self.requests: list[LLMRequest] = []

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]:
        self.requests.append(request)
        routing = request.system.startswith(_ROUTER_SYSTEM)
        if self._script and not routing:
            for event in self._script.pop(0):
                yield event
            return
        reply = _route(_last_user_text(request.messages)) if routing else _describe(request)
        # In small pieces, the way a real model streams.
        for word in re.findall(r"\S+\s*", reply):
            yield TextDelta(word)
        yield StreamEnd()

    @property
    def specialist_requests(self) -> list[LLMRequest]:
        return [r for r in self.requests if not r.system.startswith(_ROUTER_SYSTEM)]


def _last_user_text(messages: Sequence[Message]) -> str:
    for message in reversed(messages):
        if message.role == "user":
            if isinstance(message.content, str):
                return message.content
            return " ".join(getattr(part, "text", "") for part in message.content)
    return ""


def _route(prompt: str) -> str:
    request = re.search(r"^Request: (.*)$", prompt, re.MULTILINE)
    text = (request.group(1) if request else prompt).lower()
    for name, pattern in _ROUTES:
        if re.search(pattern, text):
            return name
    previous = re.search(r"handled by (\w+)", prompt)
    if previous and previous.group(1) == "vision" and _FOLLOW_UP.search(text):
        return "vision"
    return "reader"


def _describe(request: LLMRequest) -> str:
    """Orients the user, or answers a question by keyword search of the page data."""
    prompt = _last_user_text(request.messages)
    match = _PAGE_DATA.search(prompt)
    if not match:
        return "I have no page to look at."
    page = json.loads(match.group(1))
    asked = re.search(r"The user's spoken request: (.*)$", prompt, re.DOTALL)
    question = asked.group(1).strip().lower() if asked else ""
    words = _content_words(question)
    if words and not _ORIENTATION.search(question):
        return "CONFIDENCE: high\n" + _answer(page, words)
    return "CONFIDENCE: high\n" + _orient(page)


_ORIENTATION = re.compile(
    r"\b(where am i|what is this|what's this|what page|this page|on the page|overview|"
    r"summari[sz]e|describe the page)\b"
)
_STOPWORDS = set(
    "a an and are be can could do does for from how i in is it me my of on or page say "
    "says tell that the there this to was what when where which who why will with you "
    "about any have has does much many".split()
)


def _content_words(question: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", question)
    return [w.rstrip("s") for w in words if w not in _STOPWORDS and len(w) > 2]


def _orient(page: dict) -> str:
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
    if clutter := page.get("flags", {}).get("clutter_removed"):
        sentences.append(f"I skipped {clutter} ads, banners or repeated menus.")
    return " ".join(sentences)


def _answer(page: dict, words: list[str]) -> str:
    texts = [node.get("text") or node.get("name") or "" for node in page.get("nodes", [])]
    texts += [" ".join(cells) for table in page.get("tables", []) for cells in table["rows"]]
    for text in texts:
        if any(word in text.lower() for word in words):
            return f"The page says: {text.rstrip('.')}."
    return f"The page doesn't say anything about {' '.join(words)}."
