"""Specialist framework: the turn context, the specialist response (implementation.md
section 5.3), session memory and the prompt rules every specialist shares."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

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

    @property
    def last(self) -> Exchange | None:
        return self.history[-1] if self.history else None

    def remember(self, request: str, specialist: str, response: SpecialistResponse) -> None:
        self.history.append(Exchange(request, response.speech, specialist))
        self.contexts[specialist] = response.follow_up_context


@dataclass(frozen=True)
class TurnContext:
    """What a responder needs to answer one request."""

    text: str
    snapshot: PageSnapshot
    verbosity: Verbosity
    private_mode: bool
    memory: SessionMemory = field(default_factory=SessionMemory)


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
    """Takes the confidence line out of a streamed reply and passes the rest through.

    A line is held back only while it could still turn out to be the confidence line, so
    the speech keeps streaming.
    """

    def __init__(self) -> None:
        self.confidence: Confidence | None = None
        self._line = ""
        self._passing = False
        """True once the current line is known not to be the confidence line."""

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
            elif self.confidence is None and (match := _INLINE.match(self._line)):
                self.confidence = match.group(1).lower()  # type: ignore[assignment]
                out.append(self._line[match.end() :])
                self._line = ""
                self._passing = True
            elif self.confidence is not None or not self._could_be_confidence(self._line):
                out.append(self._line)
                self._line = ""
                self._passing = True
        return "".join(out)

    def flush(self) -> str:
        return self._end_line()

    def _end_line(self) -> str:
        line, self._line = self._line, ""
        match = _CONFIDENCE_LINE.match(line.strip())
        if match and self.confidence is None:
            self.confidence = match.group(1).lower()  # type: ignore[assignment]
            return ""
        return line

    @staticmethod
    def _could_be_confidence(line: str) -> bool:
        rest = _LEAD.sub("", line).lower()
        if len(rest) <= len(_WORD):
            return _WORD.startswith(rest)
        return rest.startswith(_WORD) and len(rest) < 40
