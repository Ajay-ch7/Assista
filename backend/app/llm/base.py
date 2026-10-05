"""The one interface every model provider sits behind: streaming text plus tool calling."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class ImagePart:
    """An image for a multimodal model, as base64 data."""

    data: str
    mime: str = "image/png"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    """JSON Schema of the arguments."""


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    opaque: Any = field(default=None, compare=False, repr=False)
    """Provider data that must go back with the call, such as Gemini's thought signature."""


@dataclass(frozen=True)
class Message:
    """One conversation message.

    A "tool" message is the result of the call named by `tool_call_id`. An "assistant"
    message that asked for tools lists them in `tool_calls`.
    """

    role: Literal["user", "assistant", "tool"]
    content: str | Sequence[TextPart | ImagePart] = ""
    tool_calls: Sequence[ToolCall] = ()
    tool_call_id: str | None = None


# Stream events


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolCallRequest:
    """The model asked for a tool. Emitted once per call, with complete arguments."""

    call: ToolCall


@dataclass(frozen=True)
class StreamEnd:
    stop_reason: Literal["end", "tool_use", "length"] = "end"


LLMEvent = TextDelta | ToolCallRequest | StreamEnd


@dataclass
class LLMRequest:
    system: str
    messages: Sequence[Message]
    tools: Sequence[ToolSpec] = field(default_factory=tuple)
    model: str | None = None
    """Overrides the client's default model, for example with ROUTER_MODEL."""
    max_tokens: int | None = None
    """Caps the reply. None leaves the provider's own limit in place."""


class LLMClient(ABC):
    @abstractmethod
    def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]:
        """Streams the reply: text deltas and tool calls in order, then one StreamEnd."""


async def collect_text(events: AsyncIterator[LLMEvent]) -> str:
    """Joins a stream's text, for callers that do not need streaming."""
    return "".join([event.text async for event in events if isinstance(event, TextDelta)])
