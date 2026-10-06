"""Stand-in model for tests. It needs no key and makes no network calls."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Sequence

from app.llm.base import (
    ImagePart,
    LLMClient,
    LLMEvent,
    LLMRequest,
    Message,
    StreamEnd,
    TextDelta,
    ToolCall,
    ToolCallRequest,
)
from app.llm.mock_actor import act
from app.llm.mock_advisor import advise
from app.llm.mock_watcher import watch

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*)\n</page_data_\w+>", re.DOTALL)
# Vision's system prompts contain this role line (app/agents/vision.py). See _look.
_VISION_ROLE = "\nYou are Vision."

# The Actor's system prompts contain this role line (app/agents/actor.py).
_ACTOR_ROLE = "\nYou are the Actor."
# And the Advisor's this one (app/agents/advisor.py).
_ADVISOR_ROLE = "\nYou are the Advisor."
# And the Watcher's this one (app/agents/watcher.py).
_WATCHER_ROLE = "\nYou are the Watcher."

# Router requests open with this (app/agents/router.py). The mock routes them by keyword.
_ROUTER_SYSTEM = "You route requests"
_ROUTES = [
    ("watcher", r"\b(watch|watching|watches|notify|tell me when|let me know when|alert me)\b"),
    (
        "vision",
        r"\b(image|images|photo|photos|picture|pictures|logo|chart|graph|looks? like|"
        r"colou?rs?|screen)\b",
    ),
    (
        "actor",
        r"\b(click|press|tap|type|enter|fill|select|choose|tick|untick|scroll|go back|"
        r"go to|move to|focus|open|switch|submit|search|look up|google|"
        r"add .+ to (the )?cart|place .*order|sign in|log in)\b",
    ),
    (
        "advisor",
        r"\b(total|cost|fees?|charges?|pay|hidden|tricks?|catch|dark patterns?|terms|"
        r"fine print|small print|conditions|refunds?|renew\w*)\b",
    ),
]
_AIMED_AT_ASSISTANTS = re.compile(r"\b(note|message) to (ai )?assistants?\b", re.I)
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
        if _ACTOR_ROLE in request.system:
            for event in act(request):
                yield event
            return
        if _WATCHER_ROLE in request.system:
            for event in watch(request):
                yield event
            return
        if _ADVISOR_ROLE in request.system:
            for event in advise(request):
                yield event
            return
        if _VISION_ROLE in request.system:
            async for event in _look(request):
                yield event
            return
        reply = _route(_last_user_text(request.messages)) if routing else _describe(request)
        for event in _words(reply):
            yield event
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


def _words(text: str) -> list[LLMEvent]:
    """Splits a reply into small pieces, the way a real model streams."""
    return [TextDelta(word) for word in re.findall(r"\S+\s*", text)]


async def _look(request: LLMRequest) -> AsyncIterator[LLMEvent]:
    """Stands in for the Vision specialist: looks with a tool call first, then describes.

    The mock cannot see, so it describes a picture by the alt text the page gives it.
    """
    messages = request.messages
    prompt = _last_user_text(messages)
    match = _PAGE_DATA.search(prompt)
    page = json.loads(match.group(1)) if match else {}
    alts = {image["ref"]: image.get("alt") or "no description" for image in page.get("images", [])}
    has_image = any(
        isinstance(part, ImagePart)
        for message in messages
        if not isinstance(message.content, str)
        for part in message.content
    )
    failed = next(
        (m.content for m in messages if m.role == "tool" and isinstance(m.content, str)), None
    )

    if not request.tools:  # The page view of a thin page.
        if has_image:
            reply = f"CONFIDENCE: medium\nFrom the screenshot: {_orient(page)}"
        else:
            reply = f"CONFIDENCE: low\nThis page is hard to read. {_orient(page)}"
    elif failed:
        reply = "CONFIDENCE: high\n" + failed.removeprefix("Capture failed: ")
    elif messages[-1].role == "tool":
        calls = [call for m in messages for call in m.tool_calls]
        ref = calls[-1].arguments.get("ref")
        seen = f"a picture: {alts.get(ref, 'no description')}" if ref else "the screen"
        reply = f"CONFIDENCE: medium\nI looked at {seen}."
    elif has_image:
        earlier = re.search(r"attached in this order: ([^.]+)\.", prompt)
        refs = earlier.group(1).split(", ") if earlier else []
        about = alts.get(refs[-1], "the screen") if refs else "the screen"
        reply = f"CONFIDENCE: medium\nLooking again at the picture I described: {about}."
    else:
        question = prompt.rsplit("The user's spoken request: ", 1)[-1].lower()
        if alts and not re.search(r"\b(screen|chart|graph|layout)\b", question):
            call = ToolCall(id="look_1", name="crop_element", arguments={"ref": next(iter(alts))})
        else:
            call = ToolCall(id="look_1", name="capture_screenshot", arguments={})
        yield ToolCallRequest(call)
        yield StreamEnd("tool_use")
        return
    for event in _words(reply):
        yield event
    yield StreamEnd()


def _route(prompt: str) -> str:
    request = re.search(r"^Request: (.*)$", prompt, re.MULTILINE)
    text = (request.group(1) if request else prompt).lower()
    for name, pattern in _ROUTES:
        if re.search(pattern, text):
            return name
    previous = re.search(r"handled by (\w+)", prompt)
    if previous and previous.group(1) == "vision" and _FOLLOW_UP.search(text):
        return "vision"
    # An answer to the Actor's question, or "continue" after a private field.
    answer = re.search(r"^Previous answer: (.*)$", prompt, re.MULTILINE)
    if previous and previous.group(1) == "actor" and answer:
        said = answer.group(1)
        if any(cue in said for cue in ("What should I put for", "say continue", "Shall I use it")):
            return "actor"
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
    if page.get("tables") and re.search(r"\btables?\b", question):
        return "CONFIDENCE: high\n" + _narrate(page["tables"][0])
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


def _narrate(table: dict) -> str:
    """The takeaway first (the largest value in the second column), then the size and the
    columns, then up to five rows as sentences."""
    header, *rows = table.get("rows") or [[]]
    sentences = []
    values = [(float(row[1].replace(",", "")), row) for row in rows if _is_number(row[1:2])]
    if values and len(header) > 1:
        _, top = max(values, key=lambda item: item[0])
        sentences.append(f"{top[0]} has the highest {header[1]}, {top[1]}.")
    caption = table.get("caption") or "The table"
    sentences.append(
        f"{caption} has {len(rows)} rows and {len(header)} columns: {', '.join(header)}."
    )
    for row in rows[:5]:
        pairs = [f"{name} is {value}" for name, value in zip(header[1:], row[1:], strict=False)]
        sentences.append(f"{row[0]}: {', '.join(pairs)}.")
    return " ".join(sentences)


def _is_number(cells: list[str]) -> bool:
    return bool(cells) and re.fullmatch(r"\d[\d,]*(\.\d+)?", cells[0].strip()) is not None


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
    if _AIMED_AT_ASSISTANTS.search(json.dumps(page)):
        sentences.append("The page has instructions aimed at an assistant. I ignored them.")
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
