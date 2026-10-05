"""Voice gateway: picks the speech-to-text and text-to-speech adapters named in the
environment. The rest of the backend only sees the two interfaces in base.py."""

from __future__ import annotations

from collections.abc import Callable

from app.config import ProviderNotConfigured, Settings
from app.voice.base import SpeechToText, TextToSpeech
from app.voice.deepgram import DeepgramSpeechToText, DeepgramTextToSpeech
from app.voice.mock import MockSpeechToText, MockTextToSpeech

# Provider name -> factory.
STT_PROVIDERS: dict[str, Callable[[Settings], SpeechToText]] = {
    "deepgram": lambda settings: DeepgramSpeechToText(settings.stt_api_key),
    "mock": lambda settings: MockSpeechToText(),
}
TTS_PROVIDERS: dict[str, Callable[[Settings], TextToSpeech]] = {
    "deepgram": lambda settings: DeepgramTextToSpeech(settings.tts_api_key),
    "mock": lambda settings: MockTextToSpeech(),
}


def create_stt(settings: Settings) -> SpeechToText:
    return _create("STT_PROVIDER", settings.stt_provider, STT_PROVIDERS, settings)


def create_tts(settings: Settings) -> TextToSpeech:
    return _create("TTS_PROVIDER", settings.tts_provider, TTS_PROVIDERS, settings)


def _create(variable: str, name: str, providers: dict, settings: Settings):
    if not name:
        raise ProviderNotConfigured(f"{variable} is not set")
    if name not in providers:
        known = ", ".join(sorted(providers))
        raise ProviderNotConfigured(f"{variable}={name!r} is not supported (known: {known})")
    return providers[name](settings)
