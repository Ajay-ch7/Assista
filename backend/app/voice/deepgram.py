"""Deepgram adapters: streaming speech-to-text and text-to-speech over WebSocket.

Both directions carry raw 16-bit PCM, so nothing is transcoded on the way.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from urllib.parse import urlencode

from websockets.asyncio.client import ClientConnection, connect

from app.config import ProviderNotConfigured
from app.protocol import AudioFormat
from app.voice.base import SpeechStream, SpeechToText, TextToSpeech

log = logging.getLogger("assista.deepgram")

BASE_URL = "wss://api.deepgram.com"
STT_MODEL = "nova-3"
TTS_MODEL = "aura-2-thalia-en"
TTS_SAMPLE_RATE = 24000
_CONNECT_TIMEOUT = 10


def _headers(api_key: str, variable: str) -> dict[str, str]:
    if not api_key:
        raise ProviderNotConfigured(f"{variable} is not set")
    return {"Authorization": f"Token {api_key}"}


class DeepgramSpeechToText(SpeechToText):
    def __init__(self, api_key: str, *, base_url: str = BASE_URL, model: str = STT_MODEL) -> None:
        self._headers = _headers(api_key, "STT_API_KEY")
        self._base_url = base_url
        self._model = model

    async def transcribe(self, audio: AsyncIterator[bytes], fmt: AudioFormat) -> str:
        query = urlencode(
            {
                "model": self._model,
                "language": "en",
                "encoding": "linear16",
                "sample_rate": fmt.sample_rate,
                "channels": fmt.channels,
                "smart_format": "true",
                "interim_results": "false",
            }
        )
        finals: list[str] = []
        async with connect(
            f"{self._base_url}/v1/listen?{query}",
            additional_headers=self._headers,
            open_timeout=_CONNECT_TIMEOUT,
        ) as ws:

            async def send_audio() -> None:
                async for chunk in audio:
                    await ws.send(chunk)
                # Deepgram transcribes what is left, sends it, then closes the socket.
                await ws.send(json.dumps({"type": "CloseStream"}))

            sender = asyncio.create_task(send_audio())
            try:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    if msg.get("type") == "Results" and msg.get("is_final"):
                        alternatives = msg.get("channel", {}).get("alternatives") or [{}]
                        if text := alternatives[0].get("transcript", "").strip():
                            finals.append(text)
            finally:
                if not sender.done():
                    sender.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await sender
        return " ".join(finals)


class DeepgramTextToSpeech(TextToSpeech):
    def __init__(self, api_key: str, *, base_url: str = BASE_URL, model: str = TTS_MODEL) -> None:
        self._headers = _headers(api_key, "TTS_API_KEY")
        self._base_url = base_url
        self._model = model
        self._format = AudioFormat(sample_rate=TTS_SAMPLE_RATE)

    @property
    def output_format(self) -> AudioFormat:
        return self._format

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        stream = self.open_stream()
        try:
            async for chunk in stream.synthesize(text):
                yield chunk
        finally:
            await stream.close()

    def open_stream(self) -> DeepgramSpeechStream:
        query = urlencode(
            {"model": self._model, "encoding": "linear16", "sample_rate": TTS_SAMPLE_RATE}
        )
        return DeepgramSpeechStream(self, f"{self._base_url}/v1/speak?{query}", self._headers)


class DeepgramSpeechStream(SpeechStream):
    """One WebSocket for a whole turn. Connecting takes a second or more, so the
    connection is opened once, early, and every sentence reuses it."""

    def __init__(self, tts: TextToSpeech, url: str, headers: dict[str, str]) -> None:
        super().__init__(tts)
        self._url = url
        self._headers = headers
        self._connecting: asyncio.Task[ClientConnection] | None = None
        # True while a sentence's audio is still coming. If it was cut off, for example
        # because the user started a new turn, what is left on the connection belongs to
        # the old sentence, and the connection cannot be used again.
        self._mid_sentence = False

    async def _connect(self) -> ClientConnection:
        return await connect(
            self._url, additional_headers=self._headers, open_timeout=_CONNECT_TIMEOUT
        )

    async def _connection(self) -> ClientConnection:
        if self._connecting is None:
            self._connecting = asyncio.create_task(self._connect())
        return await asyncio.shield(self._connecting)

    async def warm_up(self) -> None:
        await self._connection()

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        if self._mid_sentence:
            await self.close()
        self._mid_sentence = True
        ws = await self._connection()
        await ws.send(json.dumps({"type": "Speak", "text": text}))
        # Flush asks for the audio of everything sent so far; "Flushed" marks its end.
        await ws.send(json.dumps({"type": "Flush"}))
        async for raw in ws:
            if isinstance(raw, bytes):
                yield raw
                continue
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "Flushed":
                self._mid_sentence = False
                return
            if kind == "Error":
                raise RuntimeError(f"Deepgram text-to-speech error: {msg}")
            if kind == "Warning":
                log.warning("Deepgram text-to-speech warning: %s", msg)
        raise RuntimeError("Deepgram closed the text-to-speech connection early")

    async def close(self) -> None:
        connecting, self._connecting = self._connecting, None
        self._mid_sentence = False
        if connecting is None:
            return
        if not connecting.done():
            connecting.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            ws = await connecting
            with contextlib.suppress(Exception):
                await ws.send(json.dumps({"type": "Close"}))
            await ws.close()
