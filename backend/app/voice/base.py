"""The two interfaces every speech provider sits behind."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from app.protocol import AudioFormat


class SpeechToText(ABC):
    @abstractmethod
    async def transcribe(self, audio: AsyncIterator[bytes], fmt: AudioFormat) -> str:
        """Consumes one turn's audio as it arrives and returns the final transcript.

        `audio` yields raw PCM chunks in `fmt` and ends when the user stops talking.
        Returns an empty string when no speech was heard.
        """


class TextToSpeech(ABC):
    @property
    @abstractmethod
    def output_format(self) -> AudioFormat:
        """The format of the chunks `synthesize` yields. Must be raw 16-bit PCM."""

    @abstractmethod
    def synthesize(self, text: str) -> AsyncIterator[bytes]:
        """Streams the audio of one sentence, first chunk as early as possible."""
