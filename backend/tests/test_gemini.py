"""The Gemini adapter against a fake SDK client: no key and no network."""

import asyncio
import base64

import pytest
from google.genai import types

from app.config import ProviderNotConfigured, Settings
from app.llm.base import (
    ImagePart,
    LLMRequest,
    Message,
    StreamEnd,
    TextDelta,
    TextPart,
    ToolCall,
    ToolSpec,
)
from app.llm.gateway import create_llm
from app.llm.gemini import GeminiLLM, to_config, to_contents


def response(parts: list[dict], finish_reason: str | None = None):
    candidate = {"content": {"role": "model", "parts": parts}}
    if finish_reason:
        candidate["finish_reason"] = finish_reason
    return types.GenerateContentResponse.model_validate({"candidates": [candidate]})


class FakeClient:
    """Stands in for genai.Client: records the call and replays canned chunks."""

    def __init__(self, chunks):
        self.chunks = chunks
        self.calls: list[dict] = []
        self.aio = self
        self.models = self

    async def generate_content_stream(self, **kwargs):
        self.calls.append(kwargs)

        async def replay():
            for chunk in self.chunks:
                yield chunk

        return replay()


def run(llm: GeminiLLM, request: LLMRequest):
    async def gather():
        return [event async for event in llm.stream(request)]

    return asyncio.run(gather())


CLICK = ToolSpec(
    name="click",
    description="Click an element.",
    parameters={
        "type": "object",
        "properties": {"ref": {"type": "string"}},
        "required": ["ref"],
    },
)


def test_text_is_streamed_and_thoughts_are_left_out():
    client = FakeClient(
        [
            response([{"text": "planning...", "thought": True}]),
            response([{"text": "This is a "}]),
            response([{"text": "shop."}], "STOP"),
        ]
    )
    llm = GeminiLLM("", "main-model", client=client)
    events = run(llm, LLMRequest(system="Be brief.", messages=[Message("user", "where am I?")]))
    assert events == [TextDelta("This is a "), TextDelta("shop."), StreamEnd("end")]

    (call,) = client.calls
    assert call["model"] == "main-model"
    assert call["config"].system_instruction == "Be brief."
    assert call["config"].max_output_tokens is None
    assert call["contents"][0].role == "user"
    assert call["contents"][0].parts[0].text == "where am I?"


def test_request_model_overrides_the_default():
    client = FakeClient([response([{"text": "reader"}], "STOP")])
    llm = GeminiLLM("", "main-model", client=client)
    run(llm, LLMRequest(system="", messages=[Message("user", "hi")], model="router-model"))
    assert client.calls[0]["model"] == "router-model"


def test_tool_calls_come_back_as_events():
    client = FakeClient(
        [
            response([{"text": "Adding it. "}]),
            response([{"function_call": {"name": "click", "args": {"ref": "e5"}}}], "STOP"),
        ]
    )
    llm = GeminiLLM("", "m", client=client)
    events = run(llm, LLMRequest(system="", messages=[Message("user", "add")], tools=[CLICK]))
    assert events[0] == TextDelta("Adding it. ")
    assert events[1].call.name == "click"
    assert events[1].call.arguments == {"ref": "e5"}
    assert events[1].call.id.startswith("call_")
    assert events[2] == StreamEnd("tool_use")
    (tool,) = client.calls[0]["config"].tools
    (declaration,) = tool.function_declarations
    assert declaration.name == "click"
    assert declaration.parameters_json_schema == CLICK.parameters
    assert client.calls[0]["config"].automatic_function_calling.disable is True


def test_a_reply_cut_off_by_the_token_limit_is_reported():
    client = FakeClient([response([{"text": "This page"}], "MAX_TOKENS")])
    llm = GeminiLLM("", "m", client=client)
    events = run(llm, LLMRequest(system="", messages=[Message("user", "hi")], max_tokens=5))
    assert events[-1] == StreamEnd("length")
    assert client.calls[0]["config"].max_output_tokens == 5


def test_conversation_with_tools_and_images_is_converted():
    call = ToolCall(id="c1", name="click", arguments={"ref": "e5"})
    image = base64.b64encode(b"\x89PNG").decode()
    contents = to_contents(
        [
            Message("user", [TextPart("what is in this photo?"), ImagePart(image, "image/png")]),
            Message("assistant", "Adding it.", tool_calls=[call]),
            Message("tool", '{"ok": true}', tool_call_id="c1"),
        ]
    )
    assert [content.role for content in contents] == ["user", "model", "user"]
    assert contents[0].parts[0].text == "what is in this photo?"
    assert contents[0].parts[1].inline_data.data == b"\x89PNG"
    assert contents[0].parts[1].inline_data.mime_type == "image/png"
    assert contents[1].parts[0].text == "Adding it."
    assert contents[1].parts[1].function_call.name == "click"
    assert contents[1].parts[1].function_call.args == {"ref": "e5"}
    # The result is matched to its call by function name.
    assert contents[2].parts[0].function_response.name == "click"
    assert contents[2].parts[0].function_response.response == {"result": '{"ok": true}'}


def test_a_call_keeps_its_thought_signature_for_the_next_request():
    """Thinking models reject a function call sent back without its signature."""
    signed = {
        "function_call": {"name": "click", "args": {"ref": "e5"}},
        "thought_signature": b"sig",
    }
    llm = GeminiLLM("", "m", client=FakeClient([response([signed], "STOP")]))
    events = run(llm, LLMRequest(system="", messages=[Message("user", "add")], tools=[CLICK]))
    call = events[0].call
    assert call.opaque == b"sig"

    contents = to_contents(
        [
            Message("user", "add"),
            Message("assistant", "", tool_calls=[call]),
            Message("tool", "ok", tool_call_id=call.id),
        ]
    )
    (part,) = contents[1].parts
    assert part.function_call.name == "click"
    assert part.thought_signature == b"sig"


def test_calls_without_ids_get_ids_unique_across_rounds():
    """Results are matched to calls by id; a repeated id would pair a result with the
    wrong function."""
    unnamed = [{"function_call": {"name": "capture_screenshot", "args": {}}}]
    ids = set()
    for _ in range(3):
        llm = GeminiLLM("", "m", client=FakeClient([response(unnamed, "STOP")]))
        ids.add(run(llm, LLMRequest(system="", messages=[], tools=[CLICK]))[0].call.id)
    assert len(ids) == 3


def test_a_tool_result_carries_its_image():
    call = ToolCall(id="c1", name="crop_element", arguments={"ref": "i1"})
    image = base64.b64encode(b"\xff\xd8JPEG").decode()
    contents = to_contents(
        [
            Message("user", "describe the photo"),
            Message("assistant", "", tool_calls=[call]),
            Message(
                "tool",
                [TextPart("Captured image i1."), ImagePart(image, "image/jpeg")],
                tool_call_id="c1",
            ),
        ]
    )
    response, picture = contents[2].parts
    assert response.function_response.name == "crop_element"
    assert response.function_response.response == {"result": "Captured image i1."}
    assert picture.inline_data.data == b"\xff\xd8JPEG"
    assert picture.inline_data.mime_type == "image/jpeg"


def test_no_tools_means_no_tool_config():
    assert to_config(LLMRequest(system="s", messages=[])).tools is None


def test_gateway_needs_a_key_and_a_model():
    with pytest.raises(ProviderNotConfigured, match="LLM_API_KEY"):
        create_llm(Settings(llm_provider="gemini", llm_model="m"))
    with pytest.raises(ProviderNotConfigured, match="LLM_MODEL"):
        create_llm(Settings(llm_provider="gemini", llm_api_key="k"))
    assert isinstance(
        create_llm(Settings(llm_provider="gemini", llm_api_key="k", llm_model="m")), GeminiLLM
    )


def test_several_keys_each_get_a_client(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(
        "app.llm.gemini.genai.Client", lambda api_key: seen.append(api_key) or api_key
    )
    llm = GeminiLLM(" k1, k2 ,,k3 ", "m")
    assert seen == ["k1", "k2", "k3"]
    assert llm._clients == ["k1", "k2", "k3"]
    with pytest.raises(ProviderNotConfigured, match="LLM_API_KEY"):
        GeminiLLM(" , ", "m")
