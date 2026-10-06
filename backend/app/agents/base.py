"""Specialist framework: the turn context, the specialist response (implementation.md
section 5.3), session memory and the prompt rules every specialist shares."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

from app.documents.pdf import Document
from app.errors import TurnError
from app.llm.base import Message
from app.llm.page_data import PAGE_DATA_RULES, wrap_page_data
from app.protocol import PageSnapshot, Verbosity

Confidence = Literal["high", "medium", "low"]
CONFIDENCE_LEVELS: tuple[Confidence, ...] = ("high", "medium", "low")

HISTORY_TURNS = 4
"""Earlier exchanges a specialist sees, so follow-up questions make sense."""


@dataclass(frozen=True)
class SpecialistResponse:
    """What a specialist produced for one turn (section 5.3)."""

    speech: str
    confidence: Confidence
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    follow_up_context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Exchange:
    request: str
    reply: str
    specialist: str


@dataclass
class SessionMemory:
    """What a session remembers between turns. Lives only as long as the WebSocket."""

    history: deque[Exchange] = field(default_factory=lambda: deque(maxlen=HISTORY_TURNS))
    contexts: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Each specialist's latest follow_up_context."""
    held: HeldAction | None = None
    """The action the confirmation gate is holding, once the user has been asked."""
    document: OpenDocument | None = None
    """The PDF last read, kept so follow-ups and "continue" need no new download."""

    @property
    def last(self) -> Exchange | None:
        return self.history[-1] if self.history else None

    def remember(self, request: str, specialist: str, response: SpecialistResponse) -> None:
        self.history.append(Exchange(request, response.speech, specialist))
        self.contexts[specialist] = response.follow_up_context


@dataclass
class OpenDocument:
    """A PDF that has been read, and where reading it aloud got to."""

    document: Document
    page: int = 0
    """Index of the page to read next."""
    offset: int = 0
    """Characters of that page already read."""


@dataclass(frozen=True)
class DocumentFile:
    """The bytes of the PDF the user's tab shows."""

    url: str
    data: bytes


@dataclass(frozen=True)
class Screenshot:
    """Base64 image data from the user's tab."""

    data: str
    mime: str


class ScreenshotUnavailable(Exception):
    """The extension could not capture the screen. `reason` is a sentence for the user."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class ActionResult:
    """What the extension did with one action tool."""

    ok: bool
    held: bool = False
    """True when the confirmation gate held the action; nothing was done."""
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True)
class HeldAction:
    """An action waiting in the extension for the user's yes."""

    confirm_id: str
    control: str
    """The name of the control that would be pressed, or of the site or search."""
    verb: str = "press"
    done: str = "pressed"
    """How the action is said before and after it happens: press and pressed, open and
    opened."""


@dataclass(frozen=True)
class ConfirmedAction:
    """A held action the user said yes to, and how running it went."""

    control: str
    ok: bool
    error: str | None = None
    done: str = "pressed"


class PageAccess(ABC):
    """What a specialist may ask of the user's tab while it works on a turn."""

    @abstractmethod
    async def screenshot(self, ref: str | None = None) -> Screenshot:
        """The visible part of the tab, or the element `ref` from the turn's snapshot.

        Raises ScreenshotUnavailable when it cannot be captured.
        """

    async def snapshot(self) -> PageSnapshot:
        """A fresh snapshot of the tab, with new refs. Raises TurnError when the page
        cannot be read."""
        raise TurnError("page_unreadable", "I can't read this page right now.")

    async def document(self) -> DocumentFile:
        """The PDF the tab shows, fetched by the extension. Raises TurnError when it
        cannot be had."""
        raise TurnError("document_unavailable", "I can't open this document right now.")

    async def act(
        self, name: str, snapshot_id: str, ref: str | None, args: dict[str, Any]
    ) -> ActionResult:
        """Asks the extension to run one action tool on an element of `snapshot_id`."""
        return ActionResult(ok=False, error="unreachable_page")

    async def ask_to_confirm(self, held: HeldAction, text: str) -> None:
        """Tells the extension the user has heard `text`, the read-back of a held action,
        so that their next yes or no settles it."""
        return None


class NoPageAccess(PageAccess):
    async def screenshot(self, ref: str | None = None) -> Screenshot:
        raise ScreenshotUnavailable("unavailable", "I can't look at the screen right now.")


@dataclass(frozen=True)
class TurnContext:
    """What a responder needs to answer one request."""

    text: str
    snapshot: PageSnapshot
    verbosity: Verbosity
    private_mode: bool
    memory: SessionMemory = field(default_factory=SessionMemory)
    page: PageAccess = field(default_factory=NoPageAccess)
    confirmed: ConfirmedAction | None = None
    """Set when this turn is the user's yes to a held action, which has now run."""


@dataclass
class SpecialistOutput:
    """Filled in by a specialist while it streams its speech."""

    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    follow_up_context: dict[str, Any] = field(default_factory=dict)


class Specialist(ABC):
    name: ClassVar[str]

    @abstractmethod
    def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        """Streams the reply as text pieces. The reply may start with a confidence line,
        CONFIDENCE: high, medium or low, which is taken out before it is spoken."""


# Prompts

VERBOSITY: dict[str, str] = {
    "brief": "Answer in one or two short sentences.",
    "normal": "Answer in two to four sentences.",
    "detailed": "Give a fuller answer of up to eight sentences, most important things first.",
}

SPOKEN_STYLE = """\
You are Assista, a voice assistant that helps blind, low-vision and motor-impaired people \
use the web. The user cannot see the screen. Everything you write is turned into speech \
and played aloud.

How to write:
- Write plain spoken English in full sentences. No markdown, lists, headings, emoji or \
symbols, and do not read out web addresses.
- Never say reference ids such as e12 or i3. Name things the way the page does, for \
example "the Add to cart button".
- Start with the answer itself. {verbosity}
- Fields marked sensitive have their values withheld on purpose. Never ask the user to \
say a password, code, card number or PIN aloud."""

CONFIDENCE_RULES = """\
Confidence:
- Begin your reply with one line that says how sure you are: CONFIDENCE: high, \
CONFIDENCE: medium or CONFIDENCE: low. That line is not spoken. Then give your answer.
- high: the page states the answer plainly. medium: you are piecing it together. low: \
you are guessing, the page is unclear, or the data looks incomplete."""


def system_prompt(role: str, verbosity: Verbosity) -> str:
    """The shared rules, the specialist's own `role` text, and the page data rules."""
    style = SPOKEN_STYLE.format(verbosity=VERBOSITY[verbosity])
    return f"{style}\n\n{role}\n\n{CONFIDENCE_RULES}\n\nPage data:\n{PAGE_DATA_RULES}"


def page_messages(ctx: TurnContext, note: str = "") -> list[Message]:
    """Earlier exchanges, then the page as a data block and the user's request.

    Page content goes in the user message as a data block, never in the system prompt.
    """
    messages: list[Message] = []
    for exchange in ctx.memory.history:
        messages.append(Message("user", f"Earlier request: {exchange.request}"))
        messages.append(Message("assistant", exchange.reply))
    extra = f"{note}\n\n" if note else ""
    user = f"{wrap_page_data(ctx.snapshot)}\n\n{extra}The user's spoken request: {ctx.text}"
    messages.append(Message("user", user))
    return messages


# Confidence line

_CONFIDENCE_LINE = re.compile(r"^[\s*_#>`-]*confidence\W*(high|medium|low)\W*$", re.IGNORECASE)
# The marker followed by the answer on the same line: "CONFIDENCE: high. The page...".
_INLINE = re.compile(r"^[\s*_#>`-]*confidence\W*(high|medium|low)\b\W*?\s+(?=\S)", re.IGNORECASE)
_LEAD = re.compile(r"^[\s*_#>`-]*")
_WORD = "confidence"


class ConfidenceFilter:
    """Takes confidence lines out of a streamed reply and passes the rest through.

    A specialist that works in rounds may state its confidence more than once; the
    latest statement wins. A line is held back only while it could still turn out to be
    a confidence line, so the speech keeps streaming.
    """

    def __init__(self) -> None:
        self.confidence: Confidence | None = None
        self._line = ""
        self._passing = False
        """True once the current line is known not to be a confidence line."""

    def feed(self, text: str) -> str:
        out: list[str] = []
        for char in text:
            if self._passing:
                out.append(char)
                if char == "\n":
                    self._passing = False
                continue
            self._line += char
            if char == "\n":
                out.append(self._end_line())
            elif match := _INLINE.match(self._line):
                self.confidence = match.group(1).lower()  # type: ignore[assignment]
                out.append(self._line[match.end() :])
                self._line = ""
                self._passing = True
            elif not self._could_be_confidence(self._line):
                out.append(self._line)
                self._line = ""
                self._passing = True
        return "".join(out)

    def flush(self) -> str:
        return self._end_line()

    def _end_line(self) -> str:
        line, self._line = self._line, ""
        if match := _CONFIDENCE_LINE.match(line.strip()):
            self.confidence = match.group(1).lower()  # type: ignore[assignment]
            return ""
        return line

    @staticmethod
    def _could_be_confidence(line: str) -> bool:
        rest = _LEAD.sub("", line).lower()
        if len(rest) <= len(_WORD):
            return _WORD.startswith(rest)
        return rest.startswith(_WORD) and len(rest) < 40
