import json
from collections.abc import AsyncIterator

import pytest

from app.config import ProviderNotConfigured, Settings
from app.main import Deps
from app.protocol import AudioFormat
from app.voice.base import SpeechToText, TextToSpeech
from app.voice.gateway import create_stt, create_tts
from app.voice.mock import MockSpeechToText, MockTextToSpeech
from tests.harness import session

PCM_16K = {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1}


def mock_voice() -> dict:
    return {"stt": MockSpeechToText(), "tts": MockTextToSpeech()}


def test_spoken_turn_is_transcribed_and_answered_with_audio():
    with session(**mock_voice()) as client:
        result = client.say(b"what is ", b"this page?")
    assert result.of_type("transcript_final")[0]["text"] == "what is this page?"
    assert result.types == [
        "transcript_final",
        "request_snapshot",
        "speak_text",
        "speak_text",
        "speak_text",
        "done",
    ]
    assert all(m["audio"] == PCM_16K for m in result.of_type("speak_text"))
    assert len(result.audio) > 0
    assert all(len(chunk) % 2 == 0 for chunk in result.audio)


def test_each_sentence_is_followed_by_its_own_audio():
    with session(**mock_voice()) as client:
        client.send({"type": "audio_start", "turn_id": "t", "format": PCM_16K})
        client.ws.send_bytes(b"what is this page?")
        client.send({"type": "audio_end", "turn_id": "t"})

        order: list[str] = []
        while not order or order[-1] != "done":
            frame = client.ws.receive()
            if frame.get("bytes") is not None:
                order.append("audio")
                continue
            msg = json.loads(frame["text"])
            order.append(msg["type"])
            if msg["type"] == "request_snapshot":
                snapshot = {"snapshot_id": "s", "title": "Test page"}
                client.send({"type": "snapshot", "turn_id": "t", "snapshot": snapshot})

    first, second = (i for i, kind in enumerate(order) if kind == "speak_text")
    assert "audio" in order[first + 1 : second]
    assert "audio" in order[second + 1 : -1]


def test_silence_ends_in_a_spoken_error():
    with session(**mock_voice()) as client:
        result = client.say(b"   ")
    assert result.error["code"] == "no_speech"


def test_spoken_turn_without_providers_says_speech_is_not_set_up():
    with session() as client:
        result = client.say(b"hello")
    assert result.error["code"] == "not_configured"


def test_speech_to_text_failure_ends_in_a_spoken_error():
    class Broken(SpeechToText):
        async def transcribe(self, audio: AsyncIterator[bytes], fmt: AudioFormat) -> str:
            raise RuntimeError("provider down")

    with session(stt=Broken(), tts=MockTextToSpeech()) as client:
        result = client.say(b"hello")
    assert result.error["code"] == "stt_failed"
    assert "provider down" not in result.error["message"]


def test_text_to_speech_failure_ends_in_a_spoken_error():
    class Broken(TextToSpeech):
        @property
        def output_format(self) -> AudioFormat:
            return AudioFormat(sample_rate=24000)

        async def synthesize(self, text: str) -> AsyncIterator[bytes]:
            raise RuntimeError("provider down")
            yield b""

    with session(stt=MockSpeechToText(), tts=Broken()) as client:
        result = client.say(b"hello")
    assert result.error["code"] == "tts_failed"


def test_a_new_turn_replaces_the_one_in_progress():
    with session(**mock_voice()) as client:
        client.send({"type": "audio_start", "turn_id": "old", "format": PCM_16K})
        client.ws.send_bytes(b"never finished")
        result = client.ask("what is this page?")
    assert result.types[-1] == "done"
    assert all(m["turn_id"] == "turn-1" for m in result.messages)


def test_gateway_reports_unset_and_unknown_providers():
    with pytest.raises(ProviderNotConfigured, match="STT_PROVIDER is not set"):
        create_stt(Settings())
    with pytest.raises(ProviderNotConfigured, match="not supported"):
        create_tts(Settings(tts_provider="nonesuch"))
    assert isinstance(create_stt(Settings(stt_provider="mock")), MockSpeechToText)
    assert isinstance(create_tts(Settings(tts_provider="mock")), MockTextToSpeech)
    assert isinstance(Deps(settings=Settings(stt_provider="mock")).speech_to_text(), SpeechToText)
