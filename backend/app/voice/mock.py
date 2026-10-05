"""Stand-in speech providers for tests. They need no key and make no network calls."""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.protocol import AudioFormat
from app.voice.base import SpeechToText, TextToSpeech


class MockSpeechToText(SpeechToText):
    """Treats the audio bytes as UTF-8 text, so a test can "say" a sentence."""

    async def transcribe(self, audio: AsyncIterator[bytes], fmt: AudioFormat) -> str:
        data = b"".join([chunk async for chunk in audio])
        return data.decode("utf-8", errors="ignore").strip()


class MockTextToSpeech(TextToSpeech):
    """Produces silence: 50 ms per character, in 100 ms chunks."""

    _FORMAT = AudioFormat(sample_rate=16000)
    _CHUNK_BYTES = 3200

    @property
    def output_format(self) -> AudioFormat:
        return self._FORMAT

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        remaining = len(text) * 1600
        while remaining > 0:
            size = min(remaining, self._CHUNK_BYTES)
            yield b"\x00" * size
            remaining -= size
