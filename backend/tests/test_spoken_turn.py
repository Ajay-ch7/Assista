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


class BrokenVoice(TextToSpeech):
    """A voice that is down: every sentence fails before any audio."""

    @property
    def output_format(self) -> AudioFormat:
        return AudioFormat(sample_rate=24000)

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        raise RuntimeError("provider down")
        yield b""


def test_when_the_voice_fails_the_answer_still_arrives_as_text_to_be_spoken_locally():
    """P5.7: the browser's own voice is the fallback, so the turn must not end in an error."""
    with session(stt=MockSpeechToText(), tts=BrokenVoice()) as client:
        result = client.say(b"what is this page?")
    assert result.error is None
    assert result.types[-1] == "done"
    assert result.audio == []
    spoken = result.of_type("speak_text")
    # The first sentence was tried with audio (twice: the connection might have been
    # stale), then sent again without; the rest went out as text straight away.
    assert [(m["seq"], "audio" in m) for m in spoken] == [
        (0, True),
        (0, True),
        (0, False),
        (1, False),
        (2, False),
    ]
    assert spoken[2]["text"] == spoken[0]["text"]


class FlakyVoice(TextToSpeech):
    """A voice whose first connection has gone stale: it fails once, then works."""

    def __init__(self) -> None:
        self.streams = 0
        self.failed = False

    @property
    def output_format(self) -> AudioFormat:
        return AudioFormat(sample_rate=16000)

    def open_stream(self):
        self.streams += 1
        return super().open_stream()

    async def synthesize(self, text: str) -> AsyncIterator[bytes]:
        if not self.failed:
            self.failed = True
            raise ConnectionError("connection closed")
        yield b"\x00\x00" * 100


def test_a_stale_voice_connection_is_reopened_and_the_sentence_spoken():
    voice = FlakyVoice()
    with session(stt=MockSpeechToText(), tts=voice) as client:
        result = client.say(b"what is this page?")
    assert result.error is None
    assert voice.streams == 2
    assert len(result.audio) == 3
    # After the retry every sentence carried audio; none fell back to text.
    assert all("audio" in m for m in result.of_type("speak_text"))


def test_the_voice_connection_is_kept_between_turns():
    class Counting(MockTextToSpeech):
        opened = 0

        def open_stream(self):
            Counting.opened += 1
            return super().open_stream()

    with session(stt=MockSpeechToText(), tts=Counting()) as client:
        client.say(b"what is this page?")
        client.say(b"what is this page?")
    assert Counting.opened == 1


def test_a_spoken_reply_starts_at_the_first_clause():
    async def respond(ctx):
        yield "This is the checkout page of Riverside Outfitters, where one backpack "
        yield "is waiting, and the total is 4,946 rupees. You can continue to delivery."

    with session(stt=MockSpeechToText(), tts=MockTextToSpeech(), respond=respond) as client:
        spoken = client.say(b"where am I?")
    with session(respond=respond) as client:
        typed = client.ask("where am I?")
    assert spoken.speech == [
        "This is the checkout page of Riverside Outfitters,",
        "where one backpack is waiting, and the total is 4,946 rupees.",
        "You can continue to delivery.",
    ]
    # A typed turn keeps whole sentences.
    assert typed.speech == [
        "This is the checkout page of Riverside Outfitters, where one backpack is waiting, "
        "and the total is 4,946 rupees.",
        "You can continue to delivery.",
    ]


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
