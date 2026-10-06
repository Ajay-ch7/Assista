"""WebSocket endpoint and session state.

One WebSocket is one session. A session runs one turn at a time: a new turn cancels the
one before it.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, WebSocket
from pydantic import BaseModel, ValidationError

from app.agents.base import (
    ActionResult,
    ConfirmedAction,
    DocumentFile,
    HeldAction,
    PageAccess,
    Screenshot,
    ScreenshotUnavailable,
    SessionMemory,
    TurnContext,
)
from app.agents.team import Team
from app.config import ProviderNotConfigured, Settings
from app.confirmation import parse_confirmation
from app.errors import PAGE_UNREADABLE, TurnError
from app.llm.base import LLMClient
from app.llm.gateway import create_llm
from app.local_commands import is_local_command
from app.protocol import (
    AudioEnd,
    AudioFormat,
    AudioStart,
    Confirm,
    ConfirmRequest,
    DocumentReply,
    Done,
    Error,
    PageSnapshot,
    RequestDocument,
    RequestScreenshot,
    RequestSnapshot,
    ScreenshotReply,
    SettingsUpdate,
    SnapshotFlags,
    SnapshotReply,
    SpeakText,
    ToolCall,
    ToolResult,
    Transcript,
    TranscriptFinal,
    Verbosity,
    client_message,
)
from app.voice.base import SpeechStream, SpeechToText, TextToSpeech
from app.voice.gateway import create_stt, create_tts
from app.voice.sentences import SentenceSplitter

log = logging.getLogger("assista")

# What the user hears when a screenshot fails, by the extension's error code.
_SCREENSHOT_ERRORS = {
    "tab_not_visible": "I can only look at the tab that is on screen. Switch to it and ask again.",
    "not_visible": "That part of the page is not on screen, so I could not look at it.",
    "stale_ref": "The page changed while I was looking. Please ask again.",
    "no_tab": "I can't find a web page to look at.",
    "unreachable_page": "I can't look at this page. Try again on a regular web page.",
    "timeout": "The page did not send me a picture in time.",
}
_SCREENSHOT_FAILED = "I could not capture the screen."

# What the user hears when a PDF cannot be fetched, by the extension's error code.
_DOCUMENT_ERRORS = {
    "too_large": "This PDF is too big for me to read. I can read files up to 10 megabytes.",
    # The extension opens its details page as this is said (extension/src/panel/main.ts).
    "file_access_off": (
        "This PDF is a file on your computer, and I need your permission to open files. I "
        "have opened Assista's settings in a new tab. Turn on the switch called Allow access "
        "to file URLs. Assista will restart; then ask me again."
    ),
    "not_pdf": "I could not get a PDF file from this tab.",
    "fetch_failed": "I could not download this PDF.",
    "no_tab": "I can't find a document to read.",
    "timeout": "The PDF took too long to download.",
}
_DOCUMENT_FAILED = "I could not open this PDF."


Responder = Callable[[TurnContext], AsyncIterator[str]]
"""Answers one request as a stream of text pieces."""


def model_responder(settings: Settings, llm: LLMClient | None = None) -> Responder:
    """Answers with the router and its specialists, on the configured model."""
    team: Team | None = None

    async def respond(ctx: TurnContext) -> AsyncIterator[str]:
        nonlocal team
        if team is None:
            team = Team(
                llm or create_llm(settings),
                model=settings.llm_model or None,
                router_model=settings.router_model or None,
            )
        async for piece in team.respond(ctx):
            yield piece

    return respond


@dataclass
class Deps:
    """Everything a session needs from outside; tests replace the parts they fake."""

    settings: Settings
    respond: Responder | None = None
    stt: SpeechToText | None = None
    tts: TextToSpeech | None = None
    snapshot_timeout: float = 10.0
    screenshot_timeout: float = 10.0
    document_timeout: float = 30.0
    action_timeout: float = 20.0
    confirm_timeout: float = 10.0

    def __post_init__(self) -> None:
        if self.respond is None:
            self.respond = model_responder(self.settings)

    def speech_to_text(self) -> SpeechToText:
        if self.stt is None:
            self.stt = create_stt(self.settings)
        return self.stt

    def text_to_speech(self) -> TextToSpeech:
        if self.tts is None:
            self.tts = create_tts(self.settings)
        return self.tts


class Session:
    def __init__(self, ws: WebSocket, deps: Deps) -> None:
        self.ws = ws
        self.deps = deps
        self.verbosity: Verbosity = "normal"
        self.private_mode = False
        self.memory = SessionMemory()
        self._turn: asyncio.Task[None] | None = None
        # Microphone audio of the spoken turn in progress; None marks its end.
        self._audio: asyncio.Queue[bytes | None] | None = None
        self._audio_turn: str | None = None
        # Replies the running turn is waiting for, keyed by (turn_id, message type).
        self._pending: dict[tuple[str, str], asyncio.Future[Any]] = {}
        # Replies that arrived before the turn started waiting for them.
        self._early: dict[tuple[str, str], Any] = {}
        # The voice connection, kept open between spoken turns: opening one costs a
        # second or more, which the user would hear as silence.
        self._speech: SpeechStream | None = None

    async def run(self) -> None:
        try:
            while True:
                frame = await self.ws.receive()
                if frame["type"] == "websocket.disconnect":
                    break
                if (data := frame.get("bytes")) is not None:
                    if self._audio is not None:
                        self._audio.put_nowait(data)
                elif (text := frame.get("text")) is not None:
                    await self._on_text(text)
        finally:
            self._cancel_turn()
            if self._speech is not None:
                await self._speech.close()

    # Incoming messages

    async def _on_text(self, text: str) -> None:
        try:
            raw = json.loads(text)
        except ValueError:
            raw = None
        turn_id = raw.get("turn_id") if isinstance(raw, dict) else None
        try:
            msg = client_message.validate_python(raw)
        except ValidationError:
            await self._send(
                Error(
                    turn_id=turn_id if isinstance(turn_id, str) else "",
                    code="bad_message",
                    message="Assista received a message it did not understand.",
                )
            )
            return

        match msg:
            case Transcript():
                self._start_turn(msg.turn_id, self._answer(msg.turn_id, msg.text))
            case AudioStart():
                queue: asyncio.Queue[bytes | None] = asyncio.Queue()
                self._start_turn(msg.turn_id, self._spoken_turn(msg.turn_id, msg.format, queue))
                self._audio, self._audio_turn = queue, msg.turn_id
            case AudioEnd():
                if self._audio is not None and msg.turn_id == self._audio_turn:
                    self._audio.put_nowait(None)
                    self._audio = None
            case SettingsUpdate():
                self.verbosity = msg.verbosity
                self.private_mode = msg.private_mode
            case SnapshotReply() | ScreenshotReply() | DocumentReply() | ToolResult() | Confirm():
                self._resolve(msg.turn_id, msg.type, msg)

    def _resolve(self, turn_id: str, kind: str, msg: Any) -> None:
        future = self._pending.get((turn_id, kind))
        if future is None:
            self._early[(turn_id, kind)] = msg
        elif not future.done():
            future.set_result(msg)

    # Turns

    def _start_turn(self, turn_id: str, work: Coroutine[Any, Any, None]) -> None:
        self._cancel_turn()
        self._turn = asyncio.create_task(self._guard(turn_id, work))

    def _cancel_turn(self) -> None:
        if self._turn is not None and not self._turn.done():
            self._turn.cancel()
        self._turn = None
        self._audio = None
        self._early.clear()

    async def _guard(self, turn_id: str, work: Coroutine[Any, Any, None]) -> None:
        """Runs a turn and makes sure every failure reaches the user as a sentence."""
        try:
            await work
        except TurnError as error:
            await self._send_error(turn_id, error.code, error.message)
        except ProviderNotConfigured as error:
            log.error("not configured: %s", error)
            await self._send_error(
                turn_id, "not_configured", "The Assista server is not fully set up yet."
            )
        except Exception as error:
            log.exception("turn %s failed", turn_id)
            code, message = _explain(error)
            await self._send_error(turn_id, code, message)

    async def _spoken_turn(
        self, turn_id: str, fmt: AudioFormat, queue: asyncio.Queue[bytes | None]
    ) -> None:
        stt = self.deps.speech_to_text()
        if self._speech is None:
            self._speech = self.deps.text_to_speech().open_stream()
        speech = self._speech
        # Get the voice ready while the user is still talking. If this fails, the
        # failure shows up, and is handled, when the first sentence is spoken.
        warm_up = asyncio.create_task(speech.warm_up())
        warm_up.add_done_callback(lambda task: task.cancelled() or task.exception())

        async def audio() -> AsyncIterator[bytes]:
            while (chunk := await queue.get()) is not None:
                yield chunk

        try:
            try:
                text = (await stt.transcribe(audio(), fmt)).strip()
            except Exception as error:
                log.exception("speech-to-text failed")
                raise TurnError("stt_failed", "I could not hear that. Please try again.") from error
            if not text:
                raise TurnError("no_speech", "I didn't catch that. Please try again.")
            await self._answer(turn_id, text, speech)
        finally:
            warm_up.cancel()

    async def _answer(self, turn_id: str, text: str, tts: SpeechStream | None = None) -> None:
        if is_local_command(text):
            # Stop, repeat, speed and the like are carried out by the extension. A held
            # action stays held, so the user can ask to hear the read-back again.
            await self._send(TranscriptFinal(turn_id=turn_id, text=text))
            await self._send(Done(turn_id=turn_id))
            return

        # Any other words settle a held action: yes or no answers it, a new request
        # drops it. The extension applies the same rule to the action itself.
        held, self.memory.held = self.memory.held, None
        lead = ""
        confirmed: ConfirmedAction | None = None
        if held is not None:
            answer = parse_confirmation(text)
            if answer is None:
                await self._send(TranscriptFinal(turn_id=turn_id, text=text))
                lead = f"I have not {held.done} {held.control}.\n"
            else:
                confirmed = await self._settle(turn_id, text, held)
                if confirmed is None:
                    await self._say(turn_id, [f"Okay. I have not {held.done} {held.control}."], tts)
                    return
        else:
            await self._send(TranscriptFinal(turn_id=turn_id, text=text))

        try:
            snapshot = await self._request_snapshot(turn_id)
        except TurnError as error:
            if error.code != "page_unreadable":
                raise
            # The new-tab page and chrome:// pages cannot be read, but a site can still be
            # opened or the web searched from them. Other requests fail after routing.
            snapshot = PageSnapshot(
                snapshot_id=f"unreadable-{turn_id}", flags=SnapshotFlags(unreadable=True)
            )
        ctx = TurnContext(
            text=text,
            snapshot=snapshot,
            verbosity=self.verbosity,
            private_mode=self.private_mode,
            memory=self.memory,
            page=_SessionPage(self, turn_id),
            confirmed=confirmed,
        )

        async def pieces() -> AsyncIterator[str]:
            if lead:
                yield lead
            async for piece in self.deps.respond(ctx):
                yield piece

        await self._say(turn_id, pieces(), tts)

    async def _settle(self, turn_id: str, text: str, held: HeldAction) -> ConfirmedAction | None:
        """Waits for the extension's verdict on the user's yes or no. Returns how the
        action went when it was run, or None when it was not."""
        try:
            confirm: Confirm = await self._request(
                turn_id,
                "confirm",
                TranscriptFinal(turn_id=turn_id, text=text),
                self.deps.confirm_timeout,
            )
        except TimeoutError:
            raise TurnError(
                "confirm_lost", "I lost track of what I was about to do. Please ask me again."
            ) from None
        # The extension has the last word: it runs the action only on its own yes.
        if not confirm.approved or confirm.confirm_id != held.confirm_id:
            return None
        try:
            result: ToolResult = await self._wait(turn_id, "tool_result", self.deps.action_timeout)
        except TimeoutError:
            return ConfirmedAction(control=held.control, ok=False, error="timeout", done=held.done)
        return ConfirmedAction(
            control=held.control, ok=result.ok, error=result.error, done=held.done
        )

    async def _say(
        self, turn_id: str, pieces: AsyncIterator[str] | list[str], tts: SpeechStream | None
    ) -> None:
        """Speaks streamed text sentence by sentence, then ends the turn."""

        async def stream() -> AsyncIterator[str]:
            if isinstance(pieces, list):
                for piece in pieces:
                    yield piece
            else:
                async for piece in pieces:
                    yield piece

        # A spoken reply starts at the first clause; a typed one keeps whole sentences.
        splitter = SentenceSplitter(early_start=tts is not None)
        seq = 0
        async for piece in stream():
            for sentence in splitter.feed(piece):
                tts = await self._speak(turn_id, seq, sentence, tts)
                seq += 1
        for sentence in splitter.flush():
            tts = await self._speak(turn_id, seq, sentence, tts)
            seq += 1
        if seq == 0:
            raise TurnError("empty_reply", "I have no answer for that. Please try again.")
        await self._send(Done(turn_id=turn_id))

    async def _speak(
        self, turn_id: str, seq: int, sentence: str, tts: SpeechStream | None
    ) -> SpeechStream | None:
        """Sends one sentence, followed by its audio when the turn is spoken. Returns the
        voice to use for the next sentence: None once the voice has failed, after which
        sentences go out as text and the extension speaks them with the browser's voice."""
        if tts is None:
            await self._send(SpeakText(turn_id=turn_id, seq=seq, text=sentence))
            return None
        for attempt in (1, 2):
            sent_audio = False
            await self._send(
                SpeakText(turn_id=turn_id, seq=seq, text=sentence, audio=tts.output_format)
            )
            try:
                async for chunk in tts.synthesize(sentence):
                    await self.ws.send_bytes(chunk)
                    sent_audio = True
                return tts
            except Exception:
                log.exception("text-to-speech failed (attempt %d)", attempt)
                await tts.close()
                self._speech = None
                if sent_audio or attempt == 2:
                    break
                # A connection kept from an earlier turn may have gone stale: open a
                # fresh one and say the sentence again.
                tts = self._speech = self.deps.text_to_speech().open_stream()
        # The same sentence again, without audio: the extension's own voice takes over.
        await self._send(SpeakText(turn_id=turn_id, seq=seq, text=sentence))
        return None

    async def _request(self, turn_id: str, kind: str, request: BaseModel, wait: float) -> Any:
        """Sends `request` and waits for the extension's reply of type `kind`."""
        self._early.pop((turn_id, kind), None)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        key = (turn_id, kind)
        self._pending[key] = future
        try:
            await self._send(request)
            return await asyncio.wait_for(future, wait)
        finally:
            self._pending.pop(key, None)

    async def _wait(self, turn_id: str, kind: str, wait: float) -> Any:
        """Waits for a message of type `kind` that the extension sends unasked."""
        key = (turn_id, kind)
        if key in self._early:
            return self._early.pop(key)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[key] = future
        try:
            return await asyncio.wait_for(future, wait)
        finally:
            self._pending.pop(key, None)

    async def _request_snapshot(self, turn_id: str) -> PageSnapshot:
        try:
            reply: SnapshotReply = await self._request(
                turn_id, "snapshot", RequestSnapshot(turn_id=turn_id), self.deps.snapshot_timeout
            )
        except TimeoutError:
            raise TurnError(
                "page_timeout", "The page did not answer in time. Please try again."
            ) from None
        if reply.snapshot is None:
            raise TurnError("page_unreadable", PAGE_UNREADABLE)
        return reply.snapshot

    async def request_screenshot(self, turn_id: str, ref: str | None) -> Screenshot:
        try:
            reply: ScreenshotReply = await self._request(
                turn_id,
                "screenshot",
                RequestScreenshot(turn_id=turn_id, ref=ref),
                self.deps.screenshot_timeout,
            )
        except TimeoutError:
            reply = ScreenshotReply(turn_id=turn_id, error="timeout")
        if not reply.image:
            code = (reply.error or "failed").split(":")[0]
            raise ScreenshotUnavailable(code, _SCREENSHOT_ERRORS.get(code, _SCREENSHOT_FAILED))
        return Screenshot(data=reply.image, mime=reply.mime or "image/png")

    async def request_document(self, turn_id: str) -> DocumentFile:
        try:
            reply: DocumentReply = await self._request(
                turn_id, "document", RequestDocument(turn_id=turn_id), self.deps.document_timeout
            )
        except TimeoutError:
            reply = DocumentReply(turn_id=turn_id, error="timeout")
        data = b""
        if reply.data:
            try:
                data = base64.b64decode(reply.data, validate=True)
            except (binascii.Error, ValueError):
                reply = DocumentReply(turn_id=turn_id, error="bad_data")
        if not data:
            code = (reply.error or "failed").split(":")[0]
            raise TurnError("document_" + code, _DOCUMENT_ERRORS.get(code, _DOCUMENT_FAILED))
        return DocumentFile(url=reply.url or "", data=data)

    async def act(
        self, turn_id: str, name: str, snapshot_id: str, ref: str | None, args: dict[str, Any]
    ) -> ActionResult:
        call = ToolCall(
            turn_id=turn_id,
            call_id=uuid.uuid4().hex[:8],
            name=name,
            snapshot_id=snapshot_id,
            ref=ref,
            args=args,
        )
        try:
            reply: ToolResult = await self._request(
                turn_id, "tool_result", call, self.deps.action_timeout
            )
        except TimeoutError:
            return ActionResult(ok=False, error="timeout")
        if reply.call_id != call.call_id:
            return ActionResult(ok=False, error="timeout")
        return ActionResult(
            ok=reply.ok,
            held=bool(reply.held_by_gate),
            result=reply.result if isinstance(reply.result, dict) else {},
            error=reply.error,
        )

    async def ask_to_confirm(self, turn_id: str, held: HeldAction, text: str) -> None:
        self.memory.held = held
        await self._send(ConfirmRequest(turn_id=turn_id, confirm_id=held.confirm_id, text=text))

    # Outgoing messages

    async def _send(self, msg: BaseModel) -> None:
        await self.ws.send_text(msg.model_dump_json(exclude_none=True))

    async def _send_error(self, turn_id: str, code: str, message: str) -> None:
        try:
            await self._send(Error(turn_id=turn_id, code=code, message=message))
        except Exception:
            log.debug("could not report %s: the socket is closed", code)


class _SessionPage(PageAccess):
    """The user's tab, as seen from one turn."""

    def __init__(self, session: Session, turn_id: str) -> None:
        self._session = session
        self._turn_id = turn_id

    async def screenshot(self, ref: str | None = None) -> Screenshot:
        return await self._session.request_screenshot(self._turn_id, ref)

    async def snapshot(self) -> PageSnapshot:
        return await self._session._request_snapshot(self._turn_id)

    async def document(self) -> DocumentFile:
        return await self._session.request_document(self._turn_id)

    async def act(
        self, name: str, snapshot_id: str, ref: str | None, args: dict[str, Any]
    ) -> ActionResult:
        return await self._session.act(self._turn_id, name, snapshot_id, ref, args)

    async def ask_to_confirm(self, held: HeldAction, text: str) -> None:
        await self._session.ask_to_confirm(self._turn_id, held, text)


def _explain(error: Exception) -> tuple[str, str]:
    """A code and a spoken sentence for a failure nobody planned for. Model services
    report quota and overload in their own ways; the status code or the name is enough."""
    status = getattr(error, "code", None) or getattr(error, "status_code", None)
    text = f"{type(error).__name__} {error}"
    if status == 429 or "RESOURCE_EXHAUSTED" in text or "rate limit" in text.lower():
        return (
            "model_quota",
            "The AI service says I have reached its limit for now. Please try again in a minute.",
        )
    if status in (500, 502, 503, 504) or "UNAVAILABLE" in text or "overloaded" in text.lower():
        return "model_busy", "The AI service is busy right now. Please try again in a moment."
    if isinstance(error, TimeoutError) or "timeout" in type(error).__name__.lower():
        return "model_slow", "The AI service took too long to answer. Please try again."
    if isinstance(error, ConnectionError | OSError):
        return "no_network", "I could not reach the AI service. Please check the connection."
    return "internal", "Something went wrong on my side. Please try again."


def _origin_allowed(origin: str | None) -> bool:
    """Web pages may not open a session; the extension and local tools may."""
    return origin is None or origin.startswith("chrome-extension://")


def create_app(deps: Deps | None = None) -> FastAPI:
    app = FastAPI(title="Assista backend")
    app.state.deps = deps or Deps(settings=Settings.from_env())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        if not _origin_allowed(ws.headers.get("origin")):
            await ws.close(code=1008)
            return
        await ws.accept()
        await Session(ws, app.state.deps).run()

    return app


app = create_app()
