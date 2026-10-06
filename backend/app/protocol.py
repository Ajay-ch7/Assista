"""WebSocket protocol and page snapshot (implementation.md sections 5.1 and 5.2).

Mirrors extension/src/shared/protocol.ts and snapshot.ts; change both sides together.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

Verbosity = Literal["brief", "normal", "detailed"]
CueName = Literal["listening", "thinking", "link", "error", "done", "alert"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class AudioFormat(_Model):
    """Binary audio frames are raw PCM in this format, in both directions."""

    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    sample_rate: int = Field(gt=0)
    channels: Literal[1] = 1


# Page snapshot


class SnapshotNode(_Model):
    ref: str
    role: str
    name: str = ""
    text: str = ""
    state: dict[str, Any] | None = None
    sensitive: bool | None = None
    value: str | None = None

    @model_validator(mode="after")
    def _sensitive_nodes_carry_no_value(self) -> SnapshotNode:
        # The content script already redacts; this is a second line of defence.
        if self.sensitive:
            self.value = None
        return self


class SnapshotTable(_Model):
    ref: str
    caption: str = ""
    rows: list[list[str]] = Field(default_factory=list)


class SnapshotImage(_Model):
    ref: str
    alt: str = ""
    width: int = 0
    height: int = 0


class Countdown(_Model):
    ref: str
    seconds_left: int


class SnapshotRules(_Model):
    preticked: list[str] = Field(default_factory=list)
    countdowns: list[Countdown] = Field(default_factory=list)


class SnapshotFlags(_Model):
    has_canvas: bool = False
    thin: bool = False
    clutter_removed: int = 0
    hidden_text_removed: int = 0
    pdf: bool = False
    """The tab shows a PDF. Its text is not in the snapshot; ask for the file instead."""


class PageSnapshot(_Model):
    url: str = ""
    title: str = ""
    snapshot_id: str
    nodes: list[SnapshotNode] = Field(default_factory=list)
    tables: list[SnapshotTable] = Field(default_factory=list)
    images: list[SnapshotImage] = Field(default_factory=list)
    rules: SnapshotRules = Field(default_factory=SnapshotRules)
    flags: SnapshotFlags = Field(default_factory=SnapshotFlags)


# Extension to backend


class _Message(_Model):
    turn_id: str


class AudioStart(_Message):
    type: Literal["audio_start"] = "audio_start"
    format: AudioFormat


class AudioEnd(_Message):
    type: Literal["audio_end"] = "audio_end"


class Transcript(_Message):
    type: Literal["transcript"] = "transcript"
    text: str


class SnapshotReply(_Message):
    type: Literal["snapshot"] = "snapshot"
    snapshot: PageSnapshot | None = None
    error: str | None = None


class ScreenshotReply(_Message):
    type: Literal["screenshot"] = "screenshot"
    image: str | None = None
    mime: str | None = None
    ref: str | None = None
    error: str | None = None


class DocumentReply(_Message):
    """Reply to request_document: the PDF on show, as base64 data."""

    type: Literal["document"] = "document"
    url: str | None = None
    data: str | None = None
    mime: str | None = None
    error: str | None = None


class ToolResult(_Message):
    type: Literal["tool_result"] = "tool_result"
    call_id: str
    ok: bool
    held_by_gate: bool | None = None
    result: Any = None
    error: str | None = None


class Confirm(_Message):
    type: Literal["confirm"] = "confirm"
    confirm_id: str
    approved: bool


class SettingsUpdate(_Message):
    type: Literal["settings"] = "settings"
    verbosity: Verbosity = "normal"
    private_mode: bool = False


ClientMessage = Annotated[
    AudioStart
    | AudioEnd
    | Transcript
    | SnapshotReply
    | ScreenshotReply
    | DocumentReply
    | ToolResult
    | Confirm
    | SettingsUpdate,
    Field(discriminator="type"),
]
client_message: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


# Backend to extension


class TranscriptFinal(_Message):
    type: Literal["transcript_final"] = "transcript_final"
    text: str


class RequestSnapshot(_Message):
    type: Literal["request_snapshot"] = "request_snapshot"


class RequestScreenshot(_Message):
    type: Literal["request_screenshot"] = "request_screenshot"
    ref: str | None = None


class RequestDocument(_Message):
    """Asks for the file of the PDF on show. The extension fetches only the tab's own
    address, so no address is sent."""

    type: Literal["request_document"] = "request_document"


class ToolCall(_Message):
    type: Literal["tool_call"] = "tool_call"
    call_id: str
    name: str
    snapshot_id: str
    ref: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)


class SpeakText(_Message):
    """One sentence of the reply. With `audio` set, its binary frames follow."""

    type: Literal["speak_text"] = "speak_text"
    seq: int
    text: str
    audio: AudioFormat | None = None


class Cue(_Message):
    type: Literal["cue"] = "cue"
    name: CueName


class ConfirmRequest(_Message):
    type: Literal["confirm_request"] = "confirm_request"
    confirm_id: str
    text: str


class Done(_Message):
    type: Literal["done"] = "done"


class Error(_Message):
    type: Literal["error"] = "error"
    code: str
    message: str
    """A sentence that can be spoken to the user."""


ServerMessage = (
    TranscriptFinal
    | RequestSnapshot
    | RequestScreenshot
    | RequestDocument
    | ToolCall
    | SpeakText
    | Cue
    | ConfirmRequest
    | Done
    | Error
)
