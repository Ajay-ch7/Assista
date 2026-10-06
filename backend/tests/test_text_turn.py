import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import Deps, TurnContext, create_app
from tests.harness import NO_REPLY, SHOP_SNAPSHOT, session


def test_health():
    with TestClient(create_app(Deps(settings=Settings()))) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_text_turn_runs_from_transcript_to_done():
    with session() as client:
        result = client.ask("what is this page?")
    assert result.types == [
        "transcript_final",
        "request_snapshot",
        "speak_text",
        "speak_text",
        "speak_text",
        "done",
    ]
    assert result.of_type("transcript_final")[0]["text"] == "what is this page?"
    assert "Riverside Outfitters" in " ".join(result.speech)
    assert all(m["turn_id"] == "turn-1" for m in result.messages)


def test_text_mode_sends_speech_without_audio():
    with session() as client:
        result = client.ask("what is this page?")
    assert result.audio == []
    assert all("audio" not in m for m in result.of_type("speak_text"))


def test_reply_is_split_into_numbered_sentences():
    async def respond(ctx: TurnContext):
        for piece in ["One. Tw", "o is here! And", " three"]:
            yield piece

    with session(respond=respond) as client:
        result = client.ask("count")
    assert result.speech == ["One.", "Two is here!", "And three"]
    assert [m["seq"] for m in result.of_type("speak_text")] == [0, 1, 2]


def test_responder_receives_request_snapshot_and_settings():
    seen: list[TurnContext] = []

    async def respond(ctx: TurnContext):
        seen.append(ctx)
        yield "Done."

    with session(respond=respond) as client:
        client.send(
            {"type": "settings", "turn_id": "s", "verbosity": "brief", "private_mode": True}
        )
        client.ask("where am I?")
    (ctx,) = seen
    assert ctx.text == "where am I?"
    assert ctx.verbosity == "brief"
    assert ctx.private_mode is True
    assert ctx.snapshot.snapshot_id == "snap-1"
    assert ctx.snapshot.nodes[4].name == "Add to cart"


def test_sensitive_value_is_dropped_even_if_the_extension_sent_one():
    seen: list[TurnContext] = []

    async def respond(ctx: TurnContext):
        seen.append(ctx)
        yield "Done."

    leaky = {**SHOP_SNAPSHOT, "nodes": [{**SHOP_SNAPSHOT["nodes"][6], "value": "hunter2"}]}
    with session(respond=respond) as client:
        client.ask("read the form", snapshot=leaky)
    assert seen[0].snapshot.nodes[0].value is None


def test_unreadable_page_ends_in_a_spoken_error():
    with session() as client:
        result = client.ask("what is this page?", snapshot=None, error="unreachable_page")
    assert result.speech == []
    assert result.error["code"] == "page_unreadable"
    assert "can't read this page" in result.error["message"]


def test_missing_snapshot_times_out_with_a_spoken_error():
    with session(snapshot_timeout=0.05) as client:
        result = client.ask("what is this page?", snapshot=NO_REPLY)
    assert result.error["code"] == "page_timeout"


def test_responder_failure_ends_in_a_spoken_error():
    async def respond(ctx: TurnContext):
        raise RuntimeError("boom")
        yield ""

    with session(respond=respond) as client:
        result = client.ask("what is this page?")
    assert result.error["code"] == "internal"
    assert "boom" not in result.error["message"]


def test_session_survives_an_error_and_a_bad_message():
    with session() as client:
        client.send({"type": "no_such_type", "turn_id": "x"})
        bad = client.finish("x")
        client.ws.send_text("not json")
        worse = client.finish("")
        ok = client.ask("what is this page?")
    assert bad.error["code"] == "bad_message"
    assert worse.error["code"] == "bad_message"
    assert ok.types[-1] == "done"


def test_web_pages_cannot_open_a_session():
    with TestClient(create_app(Deps(settings=Settings()))) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}):
                pass
        with client.websocket_connect("/ws", headers={"origin": "chrome-extension://abcdef"}):
            pass


class ServiceError(Exception):
    """Shaped like a model provider's error: a status code and the provider's wording."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


@pytest.mark.parametrize(
    ("error", "code", "words"),
    [
        (ServiceError(429, "RESOURCE_EXHAUSTED: quota exceeded"), "model_quota", "limit for now"),
        (ServiceError(503, "UNAVAILABLE: high demand"), "model_busy", "busy right now"),
        (TimeoutError("read timed out"), "model_slow", "took too long"),
        (ConnectionError("no route to host"), "no_network", "check the connection"),
        (RuntimeError("boom"), "internal", "Something went wrong on my side"),
    ],
)
def test_every_failure_of_the_model_service_is_put_into_words(error, code, words):
    async def respond(ctx: TurnContext):
        raise error
        yield ""

    with session(respond=respond) as client:
        result = client.ask("what is this page?")
    assert result.error["code"] == code
    assert words in result.error["message"]
    # The provider's own wording is never read out.
    assert "RESOURCE_EXHAUSTED" not in result.error["message"]
    assert "boom" not in result.error["message"]
