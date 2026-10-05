"""Google Gemini adapter for the model gateway."""

from __future__ import annotations

import base64
import secrets
from collections.abc import AsyncIterator, Sequence
from typing import Any

from google import genai
from google.genai import types

from app.config import ProviderNotConfigured
from app.llm.base import (
    ImagePart,
    LLMClient,
    LLMEvent,
    LLMRequest,
    Message,
    StreamEnd,
    TextDelta,
    ToolCall,
    ToolCallRequest,
)


class GeminiLLM(LLMClient):
    def __init__(self, api_key: str, model: str, *, client: Any = None) -> None:
        """`model` is the default model; a request may name another, such as the router's."""
        if client is None and not api_key:
            raise ProviderNotConfigured("LLM_API_KEY is not set")
        if not model:
            raise ProviderNotConfigured("LLM_MODEL is not set")
        self._client = client or genai.Client(api_key=api_key)
        self._model = model

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]:
        chunks = await self._client.aio.models.generate_content_stream(
            model=request.model or self._model,
            contents=to_contents(request.messages),
            config=to_config(request),
        )
        calls = 0
        stop_reason = "end"
        async for chunk in chunks:
            for candidate in chunk.candidates or []:
                if candidate.finish_reason == types.FinishReason.MAX_TOKENS:
                    stop_reason = "length"
                for part in (candidate.content.parts if candidate.content else None) or []:
                    if part.function_call:
                        calls += 1
                        call = part.function_call
                        yield ToolCallRequest(
                            ToolCall(
                                # Ids must stay unique across rounds: results are matched
                                # to calls by id before they go back to Gemini.
                                id=call.id or f"call_{secrets.token_hex(6)}",
                                name=call.name or "",
                                arguments=dict(call.args or {}),
                                opaque=part.thought_signature,
                            )
                        )
                    elif part.text and not part.thought:
                        yield TextDelta(part.text)
        yield StreamEnd("tool_use" if calls else stop_reason)


def to_config(request: LLMRequest) -> types.GenerateContentConfig:
    tools = None
    if request.tools:
        declarations = [
            types.FunctionDeclaration(
                name=tool.name,
                description=tool.description,
                parameters_json_schema=tool.parameters,
            )
            for tool in request.tools
        ]
        tools = [types.Tool(function_declarations=declarations)]
    return types.GenerateContentConfig(
        system_instruction=request.system,
        tools=tools,
        max_output_tokens=request.max_tokens,
        # Tool calls are returned to the caller, which runs them in the extension.
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )


def to_contents(messages: Sequence[Message]) -> list[types.Content]:
    # Gemini matches a tool result to its call by function name, not by call id.
    names = {call.id: call.name for message in messages for call in message.tool_calls}
    contents: list[types.Content] = []
    for message in messages:
        if message.role == "tool":
            response = types.Part.from_function_response(
                name=names.get(message.tool_call_id or "", ""),
                response={"result": _text_of(message)},
            )
            # An image the tool produced, such as a screenshot, goes beside the response.
            images = [p for p in _content_parts(message) if p.inline_data is not None]
            contents.append(types.Content(role="user", parts=[response, *images]))
            continue
        parts = _content_parts(message)
        # Thinking models reject a call sent back without its thought signature.
        parts += [
            types.Part(
                function_call=types.FunctionCall(name=call.name, args=call.arguments),
                thought_signature=call.opaque,
            )
            for call in message.tool_calls
        ]
        role = "model" if message.role == "assistant" else "user"
        contents.append(types.Content(role=role, parts=parts))
    return contents


def _content_parts(message: Message) -> list[types.Part]:
    if isinstance(message.content, str):
        return [types.Part.from_text(text=message.content)] if message.content else []
    parts: list[types.Part] = []
    for part in message.content:
        if isinstance(part, ImagePart):
            parts.append(
                types.Part.from_bytes(data=base64.b64decode(part.data), mime_type=part.mime)
            )
        elif part.text:
            parts.append(types.Part.from_text(text=part.text))
    return parts


def _text_of(message: Message) -> str:
    if isinstance(message.content, str):
        return message.content
    return " ".join(part.text for part in message.content if not isinstance(part, ImagePart))
