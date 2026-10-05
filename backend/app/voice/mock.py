"""Stand-in speech providers for tests. They need no key and make no network calls."""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.protocol import AudioFormat
from app.voice.base import SpeechToText, TextToSpeech


class MockSpeechToText(SpeechToText):
    """Lets a test "say" a sentence by sending it as UTF-8 bytes in place of audio.

    Real audio, such as a browser's fake microphone, is heard as DEFAULT_TRANSCRIPT.
    No audio, or only whitespace, is heard as silence.
    """

    DEFAULT_TRANSCRIPT = "what is this page?"

    async def transcribe(self, audio: AsyncIterator[bytes], fmt: AudioFormat) -> str:
        data = b"".join([chunk async for chunk in audio])
        if not data.strip():
            return ""
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return self.DEFAULT_TRANSCRIPT
        return text.strip() if text.isprintable() else self.DEFAULT_TRANSCRIPT


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
