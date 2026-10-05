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

    def open_stream(self) -> SpeechStream:
        """Returns the speech output for one turn.

        Providers that speak over a connection override this to open it once per turn
        instead of once per sentence.
        """
        return SpeechStream(self)


class SpeechStream:
    """One turn's speech output: sentences are synthesized one after another."""

    def __init__(self, tts: TextToSpeech) -> None:
        self._tts = tts

    @property
    def output_format(self) -> AudioFormat:
        return self._tts.output_format

    async def warm_up(self) -> None:
        """Gets ready to speak. Called while the user is still talking, to save time."""

    def synthesize(self, text: str) -> AsyncIterator[bytes]:
        return self._tts.synthesize(text)

    async def close(self) -> None:
        """Releases the stream. Safe to call at any point, more than once."""
