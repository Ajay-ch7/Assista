"""Watcher: sets up, lists and cancels page watches from speech (F16).

The model is used once per request: to pick the element to watch and the condition, and
to phrase the alert that will be spoken when the watch fires. The watching itself is
ordinary code in the extension, and what the user hears back about a watch is written
here from the extension's own result, so it says only what was really set up.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from app.agents.base import (
    ActionResult,
    Specialist,
    SpecialistOutput,
    TurnContext,
    page_messages,
    system_prompt,
)
from app.llm.base import LLMClient, LLMRequest, TextDelta, ToolCall, ToolCallRequest
from app.tools.watch import CANCEL_WATCH, LIST_WATCHES, SET_WATCH, WATCHER_TOOLS

log = logging.getLogger("assista.watcher")

# The mock model recognises the Watcher by "You are the Watcher."; keep
# app/llm/mock_watcher.py in step.
ROLE = """\
You are the Watcher. You watch parts of web pages for the user and tell them later when \
something changes, such as a price dropping or an item coming back in stock.

- To start a watch, call set_watch. Point it at the smallest element in the page data \
whose text holds the value, for example the paragraph that says "Price: 4,499 rupees", \
not the whole product section. Pick the condition that matches the request: "tell me if \
the price drops" is decreases, "when it goes under 4,000" is below with value 4000, \
"when it is back in stock" is contains with value "in stock", and anything vaguer is \
changes.
- Give the watch a short label the user would recognise, and write the alert as one \
spoken sentence with {value} where the new text will go, for example "The price of the \
Trail Backpack is now {value}."
- If the user asks what you are watching, call list_watches. If they ask you to stop, \
call cancel_watch with words from that watch.
- If the page does not show the thing they want watched, say so and do not set a watch. \
Never watch a password, code or card field.
- Call the tool and say nothing else; the user is told the outcome for you."""

WHILE_OPEN = "This works for as long as the page stays open in a tab."
NOTHING_WATCHED = "I am not watching anything at the moment."

_FAILURES = {
    "stale_ref": "the page changed while I was setting it up. Please ask again",
    "missing_ref": "I could not tell which part of the page to watch",
    "sensitive_field": "that is a private field, and I never watch those",
    "no_tab": "there is no web page to watch",
    "unreachable_page": "this page cannot be watched",
    "timeout": "the page did not answer in time",
}


class Watcher(Specialist):
    name = "watcher"

    def __init__(self, llm: LLMClient, model: str | None = None) -> None:
        self.llm = llm
        self.model = model

    async def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        request = LLMRequest(
            system=system_prompt(ROLE, ctx.verbosity),
            messages=page_messages(ctx),
            tools=WATCHER_TOOLS,
            model=self.model,
        )
        calls: list[ToolCall] = []
        said = ""
        async for event in self.llm.stream(request):
            if isinstance(event, TextDelta):
                said += event.text
            elif isinstance(event, ToolCallRequest):
                calls.append(event.call)
        if not calls:
            yield said
            return

        sentences: list[str] = []
        for call in calls:
            out.tool_calls.append({"name": call.name, "arguments": call.arguments})
            ref = call.arguments.get("ref")
            args = {key: value for key, value in call.arguments.items() if key != "ref"}
            result = await ctx.page.act(
                call.name, ctx.snapshot.snapshot_id, ref if isinstance(ref, str) else None, args
            )
            sentences.append(_outcome(call.name, result))
        yield "CONFIDENCE: high\n" + " ".join(sentences)


def _outcome(tool: str, result: ActionResult) -> str:
    """What the user hears about one watch tool, from what the extension really did."""
    watches: list[dict[str, Any]] = [
        w for w in result.result.get("watches") or [] if isinstance(w, dict)
    ]
    if tool == SET_WATCH.name:
        if not result.ok or not watches:
            return f"I could not set up that watch: {_failure(result.error)}."
        watch = watches[0]
        value = str(watch.get("value") or "nothing").rstrip(". ")
        return (
            f"I am watching {watch.get('label')}. Right now it says: {value}. I will "
            f"tell you when it {watch.get('condition')}. {WHILE_OPEN}"
        )
    if tool == LIST_WATCHES.name:
        if not result.ok:
            return f"I could not check my watches: {_failure(result.error)}."
        if not watches:
            return NOTHING_WATCHED
        count = "one thing" if len(watches) == 1 else f"{len(watches)} things"
        items = [
            f"{w.get('label')} on {w.get('page')}. It says: "
            f"{str(w.get('value') or 'nothing').rstrip('. ')}. I will tell you when it "
            f"{w.get('condition')}."
            for w in watches
        ]
        return f"I am watching {count}. " + " ".join(items)
    if tool == CANCEL_WATCH.name:
        if result.error == "no_such_watch":
            return "I am not watching anything like that."
        if not result.ok:
            return f"I could not stop that watch: {_failure(result.error)}."
        return f"I have stopped watching {result.result.get('detail') or 'it'}."
    return "I could not do that."


def _failure(error: str | None) -> str:
    code = (error or "failed").split(":")[0].strip()
    return _FAILURES.get(code, "something went wrong")
