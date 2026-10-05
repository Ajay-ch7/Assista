import asyncio

import pytest

from app.agents.base import SessionMemory, SpecialistResponse
from app.agents.router import SYSTEM, build_request, parse, route
from app.llm.base import LLMClient, StreamEnd, TextDelta
from app.llm.mock import MockLLM


class Replies(LLMClient):
    """A model that answers every request with `reply`."""

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.requests = []

    async def stream(self, request):
        self.requests.append(request)
        yield TextDelta(self.reply)
        yield StreamEnd()


class Broken(LLMClient):
    async def stream(self, request):
        raise RuntimeError("model down")
        yield


@pytest.mark.parametrize(
    ("reply", "name"),
    [
        ("reader", "reader"),
        ("Vision", "vision"),
        ("  actor.\n", "actor"),
        ("The advisor should take this.", "advisor"),
        ("**watcher**", "watcher"),
        ("I am not sure", None),
    ],
)
def test_parse_finds_the_specialist_in_the_reply(reply, name):
    assert parse(reply) == name


def test_route_uses_the_router_model_and_the_reply():
    llm = Replies("vision")
    assert asyncio.run(route(llm, "describe the photo", SessionMemory(), "small-model")) == "vision"
    (request,) = llm.requests
    assert request.model == "small-model"
    assert request.system == SYSTEM
    assert request.messages[0].content == "Request: describe the photo"


@pytest.mark.parametrize("llm", [Replies("hmm, hard to say"), Broken()])
def test_route_falls_back_to_the_reader(llm):
    assert asyncio.run(route(llm, "what?", SessionMemory())) == "reader"


def test_the_previous_turn_is_shown_for_follow_ups():
    memory = SessionMemory()
    memory.remember("describe the photo", "vision", SpecialistResponse("A green backpack.", "high"))
    content = build_request("what colour is it?", memory).messages[0].content
    assert content == (
        "Previous request (handled by vision): describe the photo\n"
        "Previous answer: A green backpack.\n"
        "Request: what colour is it?"
    )


@pytest.mark.parametrize(
    ("text", "name"),
    [
        ("where am I?", "reader"),
        ("what does the page say about returns?", "reader"),
        ("describe the product photo", "vision"),
        ("click add to cart", "actor"),
        ("what is the total cost?", "advisor"),
        ("tell me when the price drops", "watcher"),
    ],
)
def test_the_mock_router_routes_by_keyword(text, name):
    assert asyncio.run(route(MockLLM(), text, SessionMemory())) == name


def test_the_mock_router_keeps_image_follow_ups_with_vision():
    memory = SessionMemory()
    memory.remember("describe the photo", "vision", SpecialistResponse("A backpack.", "high"))
    assert asyncio.run(route(MockLLM(), "is it waterproof?", memory)) == "vision"
    assert asyncio.run(route(MockLLM(), "is it waterproof?", SessionMemory())) == "reader"
