import asyncio

import pytest

from app.config import ProviderNotConfigured, Settings
from app.llm.base import (
    LLMRequest,
    Message,
    StreamEnd,
    TextDelta,
    ToolCall,
    ToolCallRequest,
    ToolSpec,
    collect_text,
)
from app.llm.gateway import create_llm
from app.llm.mock import MockLLM


def run(stream):
    async def gather():
        return [event async for event in stream]

    return asyncio.run(gather())


def test_gateway_reports_unset_and_unknown_providers():
    with pytest.raises(ProviderNotConfigured, match="LLM_PROVIDER is not set"):
        create_llm(Settings())
    with pytest.raises(ProviderNotConfigured, match="not supported"):
        create_llm(Settings(llm_provider="nonesuch"))
    assert isinstance(create_llm(Settings(llm_provider="mock")), MockLLM)


def test_text_streams_in_pieces_and_ends_once():
    llm = MockLLM()
    request = LLMRequest(system="s", messages=[Message("user", "hello")])
    events = run(llm.stream(request))
    assert len([e for e in events if isinstance(e, TextDelta)]) > 1
    assert events[-1] == StreamEnd()
    assert [e for e in events if isinstance(e, StreamEnd)] == [StreamEnd()]
    assert asyncio.run(collect_text(MockLLM().stream(request))) == "I have no page to look at."


def test_tool_calls_pass_through_the_interface():
    call = ToolCall(id="c1", name="click", arguments={"ref": "e5"})
    llm = MockLLM(
        script=[
            [TextDelta("Adding it. "), ToolCallRequest(call), StreamEnd("tool_use")],
            [TextDelta("Done."), StreamEnd()],
        ]
    )
    click = ToolSpec(
        name="click",
        description="Click an element.",
        parameters={"type": "object", "properties": {"ref": {"type": "string"}}},
    )

    first = run(
        llm.stream(LLMRequest(system="s", messages=[Message("user", "add")], tools=[click]))
    )
    assert first[1] == ToolCallRequest(call)
    assert first[-1].stop_reason == "tool_use"

    follow_up = [
        Message("user", "add"),
        Message("assistant", "Adding it. ", tool_calls=[call]),
        Message("tool", '{"ok": true}', tool_call_id="c1"),
    ]
    second = run(llm.stream(LLMRequest(system="s", messages=follow_up, tools=[click])))
    assert second == [TextDelta("Done."), StreamEnd()]
    assert llm.requests[0].tools == [click]
    assert llm.requests[1].messages[2].tool_call_id == "c1"


def test_request_can_override_the_model():
    llm = MockLLM()
    run(llm.stream(LLMRequest(system="s", messages=[], model="small-router-model")))
    assert llm.requests[0].model == "small-router-model"
