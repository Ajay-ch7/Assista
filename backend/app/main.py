"""WebSocket endpoint and session state.

One WebSocket is one session. A session runs one turn at a time: a new turn cancels the
one before it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, WebSocket
from pydantic import BaseModel, ValidationError

from app.agents.page_answer import answer_from_page
from app.config import ProviderNotConfigured, Settings
from app.llm.base import LLMClient
from app.llm.gateway import create_llm
from app.protocol import (
    AudioEnd,
    AudioFormat,
    AudioStart,
    Confirm,
    Done,
    Error,
    PageSnapshot,
    RequestSnapshot,
    ScreenshotReply,
    SettingsUpdate,
    SnapshotReply,
    SpeakText,
    ToolResult,
    Transcript,
    TranscriptFinal,
    Verbosity,
    client_message,
)
from app.voice.base import SpeechToText, TextToSpeech
from app.voice.gateway import create_stt, create_tts
from app.voice.sentences import SentenceSplitter

log = logging.getLogger("assista")


class TurnError(Exception):
    """Ends the turn with a sentence the user will hear."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class TurnContext:
    """What a responder needs to answer one request."""

    text: str
    snapshot: PageSnapshot
    verbosity: Verbosity
    private_mode: bool


Responder = Callable[[TurnContext], AsyncIterator[str]]
"""Answers one request as a stream of text pieces."""


def model_responder(settings: Settings, llm: LLMClient | None = None) -> Responder:
    """Answers from the page snapshot with the configured model."""
    client = llm

    async def respond(ctx: TurnContext) -> AsyncIterator[str]:
        nonlocal client
        if client is None:
            client = create_llm(settings)
        pieces = answer_from_page(
            client, ctx.text, ctx.snapshot, ctx.verbosity, model=settings.llm_model or None
        )
        async for piece in pieces:
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
        self._turn: asyncio.Task[None] | None = None
        # Microphone audio of the spoken turn in progress; None marks its end.
        self._audio: asyncio.Queue[bytes | None] | None = None
        self._audio_turn: str | None = None
        # Replies the running turn is waiting for, keyed by (turn_id, message type).
        self._pending: dict[tuple[str, str], asyncio.Future[Any]] = {}

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
            case SnapshotReply() | ScreenshotReply() | ToolResult() | Confirm():
                self._resolve(msg.turn_id, msg.type, msg)

    def _resolve(self, turn_id: str, kind: str, msg: Any) -> None:
        future = self._pending.get((turn_id, kind))
        if future is not None and not future.done():
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
        except Exception:
            log.exception("turn %s failed", turn_id)
            await self._send_error(
                turn_id, "internal", "Something went wrong on my side. Please try again."
            )

    async def _spoken_turn(
        self, turn_id: str, fmt: AudioFormat, queue: asyncio.Queue[bytes | None]
    ) -> None:
        stt = self.deps.speech_to_text()
        tts = self.deps.text_to_speech()

        async def audio() -> AsyncIterator[bytes]:
            while (chunk := await queue.get()) is not None:
                yield chunk

        try:
            text = (await stt.transcribe(audio(), fmt)).strip()
        except Exception as error:
            log.exception("speech-to-text failed")
            raise TurnError("stt_failed", "I could not hear that. Please try again.") from error
        if not text:
            raise TurnError("no_speech", "I didn't catch that. Please try again.")
        await self._answer(turn_id, text, tts)

    async def _answer(self, turn_id: str, text: str, tts: TextToSpeech | None = None) -> None:
        await self._send(TranscriptFinal(turn_id=turn_id, text=text))
        snapshot = await self._request_snapshot(turn_id)
        ctx = TurnContext(
            text=text,
            snapshot=snapshot,
            verbosity=self.verbosity,
            private_mode=self.private_mode,
        )

        splitter = SentenceSplitter()
        seq = 0
        async for piece in self.deps.respond(ctx):
            for sentence in splitter.feed(piece):
                await self._speak(turn_id, seq, sentence, tts)
                seq += 1
        for sentence in splitter.flush():
            await self._speak(turn_id, seq, sentence, tts)
            seq += 1
        if seq == 0:
            raise TurnError("empty_reply", "I have no answer for that. Please try again.")
        await self._send(Done(turn_id=turn_id))

    async def _speak(self, turn_id: str, seq: int, sentence: str, tts: TextToSpeech | None) -> None:
        """Sends one sentence, followed by its audio when the turn is spoken."""
        if tts is None:
            await self._send(SpeakText(turn_id=turn_id, seq=seq, text=sentence))
            return
        await self._send(
            SpeakText(turn_id=turn_id, seq=seq, text=sentence, audio=tts.output_format)
        )
        try:
            async for chunk in tts.synthesize(sentence):
                await self.ws.send_bytes(chunk)
        except Exception as error:
            log.exception("text-to-speech failed")
            raise TurnError("tts_failed", "I could not produce speech for my answer.") from error

    async def _request_snapshot(self, turn_id: str) -> PageSnapshot:
        future: asyncio.Future[SnapshotReply] = asyncio.get_running_loop().create_future()
        key = (turn_id, "snapshot")
        self._pending[key] = future
        try:
            await self._send(RequestSnapshot(turn_id=turn_id))
            reply = await asyncio.wait_for(future, self.deps.snapshot_timeout)
        except TimeoutError:
            raise TurnError(
                "page_timeout", "The page did not answer in time. Please try again."
            ) from None
        finally:
            self._pending.pop(key, None)
        if reply.snapshot is None:
            raise TurnError(
                "page_unreadable", "I can't read this page. Try again on a regular web page."
            )
        return reply.snapshot

    # Outgoing messages

    async def _send(self, msg: BaseModel) -> None:
        await self.ws.send_text(msg.model_dump_json(exclude_none=True))

    async def _send_error(self, turn_id: str, code: str, message: str) -> None:
        try:
            await self._send(Error(turn_id=turn_id, code=code, message=message))
        except Exception:
            log.debug("could not report %s: the socket is closed", code)


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
