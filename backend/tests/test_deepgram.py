"""The Deepgram adapters against a local WebSocket server that speaks Deepgram's
protocol: no key and no network."""

import asyncio
import json
from collections.abc import AsyncIterator
from urllib.parse import parse_qs, urlparse

import pytest
from websockets.asyncio.server import serve

from app.config import ProviderNotConfigured, Settings
from app.protocol import AudioFormat
from app.voice.deepgram import DeepgramSpeechToText, DeepgramTextToSpeech
from app.voice.gateway import create_stt, create_tts


class FakeDeepgram:
    def __init__(self) -> None:
        self.paths: list[str] = []
        self.auth: list[str | None] = []
        self.audio = b""
        self.client_messages: list[dict] = []
        self.tts_error = False

    async def handle(self, ws) -> None:
        self.paths.append(ws.request.path)
        self.auth.append(ws.request.headers.get("Authorization"))
        if ws.request.path.startswith("/v1/listen"):
            await self._listen(ws)
        else:
            await self._speak(ws)

    async def _listen(self, ws) -> None:
        def results(text: str, is_final: bool) -> str:
            channel = {"alternatives": [{"transcript": text, "confidence": 0.99}]}
            return json.dumps({"type": "Results", "is_final": is_final, "channel": channel})

        async for raw in ws:
            if isinstance(raw, bytes):
                self.audio += raw
                continue
            self.client_messages.append(json.loads(raw))
            if json.loads(raw)["type"] == "CloseStream":
                await ws.send(results("what is", False))
                await ws.send(results("What is this", True))
                await ws.send(results("", True))
                await ws.send(results("page?", True))
                await ws.send(json.dumps({"type": "Metadata", "duration": 1.2}))
                return

    async def _speak(self, ws) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            self.client_messages.append(msg)
            if msg["type"] == "Flush":
                if self.tts_error:
                    await ws.send(json.dumps({"type": "Error", "err_msg": "bad text"}))
                    continue
                await ws.send(json.dumps({"type": "Metadata", "model_name": "aura"}))
                await ws.send(b"\x01\x02" * 100)
                await ws.send(b"\x03\x04" * 50)
                await ws.send(json.dumps({"type": "Flushed", "sequence_id": 0}))


def with_server(scenario, fake: FakeDeepgram | None = None):
    """Runs `scenario(base_url, fake)` against a fake Deepgram on a free local port."""
    fake = fake or FakeDeepgram()

    async def main():
        async with serve(fake.handle, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            return await scenario(f"ws://127.0.0.1:{port}", fake)

    return asyncio.run(main()), fake


async def chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


def test_speech_to_text_streams_audio_and_joins_final_results():
    async def scenario(url, fake):
        stt = DeepgramSpeechToText("secret-key", base_url=url)
        return await stt.transcribe(
            chunks(b"\x00\x01", b"\x02\x03"), AudioFormat(sample_rate=16000)
        )

    text, fake = with_server(scenario)
    assert text == "What is this page?"
    assert fake.audio == b"\x00\x01\x02\x03"
    assert fake.client_messages == [{"type": "CloseStream"}]
    assert fake.auth == ["Token secret-key"]
    query = parse_qs(urlparse(fake.paths[0]).query)
    assert query["encoding"] == ["linear16"]
    assert query["sample_rate"] == ["16000"]
    assert query["channels"] == ["1"]
    assert query["model"] == ["nova-3"]


def test_text_to_speech_streams_pcm_until_flushed():
    async def scenario(url, fake):
        tts = DeepgramTextToSpeech("secret-key", base_url=url)
        audio = [chunk async for chunk in tts.synthesize("This is a shop.")]
        return audio, tts.output_format

    (audio, fmt), fake = with_server(scenario)
    assert audio == [b"\x01\x02" * 100, b"\x03\x04" * 50]
    assert fake.client_messages[:2] == [
        {"type": "Speak", "text": "This is a shop."},
        {"type": "Flush"},
    ]
    assert fake.auth == ["Token secret-key"]
    query = parse_qs(urlparse(fake.paths[0]).query)
    assert query["encoding"] == ["linear16"]
    assert query["sample_rate"] == [str(fmt.sample_rate)]
    assert fmt.encoding == "pcm_s16le"


def test_text_to_speech_error_is_raised():
    fake = FakeDeepgram()
    fake.tts_error = True

    async def scenario(url, _fake):
        tts = DeepgramTextToSpeech("secret-key", base_url=url)
        return [chunk async for chunk in tts.synthesize("hello")]

    with pytest.raises(RuntimeError, match="bad text"):
        with_server(scenario, fake)


def test_gateway_needs_keys():
    with pytest.raises(ProviderNotConfigured, match="STT_API_KEY"):
        create_stt(Settings(stt_provider="deepgram"))
    with pytest.raises(ProviderNotConfigured, match="TTS_API_KEY"):
        create_tts(Settings(tts_provider="deepgram"))
    settings = Settings(
        stt_provider="deepgram", stt_api_key="k", tts_provider="deepgram", tts_api_key="k"
    )
    assert isinstance(create_stt(settings), DeepgramSpeechToText)
    assert isinstance(create_tts(settings), DeepgramTextToSpeech)


def test_a_turn_speaks_every_sentence_over_one_connection():
    async def scenario(url, fake):
        stream = DeepgramTextToSpeech("secret-key", base_url=url).open_stream()
        await stream.warm_up()
        first = [chunk async for chunk in stream.synthesize("One.")]
        second = [chunk async for chunk in stream.synthesize("Two.")]
        await stream.close()
        await stream.close()
        return first, second

    (first, second), fake = with_server(scenario)
    assert first == second == [b"\x01\x02" * 100, b"\x03\x04" * 50]
    assert len(fake.paths) == 1
    spoken = [m["text"] for m in fake.client_messages if m["type"] == "Speak"]
    assert spoken == ["One.", "Two."]


def test_a_sentence_that_was_cut_off_does_not_leak_into_the_next():
    async def scenario(url, fake):
        stream = DeepgramTextToSpeech("secret-key", base_url=url).open_stream()
        cut_off = stream.synthesize("A long sentence the user interrupts.")
        first_chunk = await anext(cut_off)
        await cut_off.aclose()
        after = [chunk async for chunk in stream.synthesize("The next answer.")]
        await stream.close()
        return first_chunk, after

    (first_chunk, after), fake = with_server(scenario)
    assert first_chunk == b"\x01\x02" * 100
    # The next sentence came whole, over a fresh connection.
    assert after == [b"\x01\x02" * 100, b"\x03\x04" * 50]
    assert len(fake.paths) == 2
