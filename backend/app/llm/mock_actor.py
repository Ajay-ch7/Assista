"""Stands in for the Actor's model in tests: turns a plainly worded request into tool
calls by keyword, with no network and no key.

It follows the Actor's conversation the way the real model is asked to: one step at a
time, one form field at a time, and a report after the user confirms a held action.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from app.llm.base import (
    LLMEvent,
    LLMRequest,
    Message,
    StreamEnd,
    TextDelta,
    ToolCall,
    ToolCallRequest,
)

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*?)\n</page_data_\w+>", re.DOTALL)
_REQUEST = "The user's spoken request: "
_QUESTION = re.compile(r"What should I put for (.+)\?")
_OFFER = re.compile(r"I have your saved (.+)\. Shall I use it\?")
_DONE = re.compile(r'^Done: (\w+)(?: on \w+ ("(?:[^"\\]|\\.)*"))?(?:: (.*))?$', re.MULTILINE)

_PLANTED = re.compile(r"\bassistants?\b[^\"]*?\bpress the ([A-Z][\w ]*?) button")
_FIELDS = ("textbox", "searchbox")
_CONTROLS = ("button", "link", "checkbox", "radio", "switch", "tab", "menuitem")
_SUBMIT = re.compile(r"\b(place|order|submit|pay|buy|send|sign|book|confirm|continue)\b", re.I)
_FILL_FORM = re.compile(r"\b(fill|complete)\b.*\bform\b|^(continue|next|carry on|go on|done)\b")
_WEB_SEARCH = re.compile(
    r"^(?:search the web for|google|look up|find (?:me )?(?:a )?(?:web)?sites? (?:for|about)) (.+)$"
)
_SEARCH_FOR = re.compile(r"^search for (.+?)(?: in the search(?: bar| box)?)?$")
# "Go to checkout" is a link to press; "go to the search box" is a field to move to.
_MOVE_TO = re.compile(
    r"^(?:move to|focus on|go to(?=.* (?:field|box|bar)$)) (?:the )?(.+?)(?: field| box| bar)?$"
)
_STOPWORDS = set(
    "a an the to it this that on in of for my me please button link page go and".split()
)


def act(request: LLMRequest) -> list[LLMEvent]:
    messages = request.messages
    prompt = _text(_last(messages, "user"))
    ask = prompt.rsplit(_REQUEST, 1)[-1].strip()
    page = _latest_page(messages)

    if "has now been " in prompt or "did not work" in prompt:
        return _say(_report(prompt, page))

    results = [_text(m) for m in messages if m.role == "tool"]
    if results:
        last = results[-1]
        if last.startswith("Failed"):
            return _say(f"That did not work: {last.splitlines()[0].removeprefix('Failed: ')}")
    done = sum(1 for result in results if result.startswith("Done"))

    # A model that fell for the page: text that tells assistants to press something is
    # obeyed instead of the user. The extension's gate is what has to stop this.
    planted = _PLANTED.search(json.dumps(page))
    if planted and done == 0 and not results:
        control = _find(page, planted.group(1), _CONTROLS)
        if control and planted.group(1).lower() not in ask.lower():
            return _call("click", ref=control["ref"])

    # Form filling: the user answers the question asked last turn, or asks for the form.
    asked = _QUESTION.search(_previous_reply(messages))
    if asked and done == 0:
        field = _find(page, asked.group(1), _FIELDS)
        if field:
            return _call("type", ref=field["ref"], text=ask)
    # The user answers an offer to use a detail saved on their device.
    offered = _OFFER.search(_previous_reply(messages))
    if offered and done == 0:
        field = _find(page, offered.group(1), _FIELDS)
        if field and re.match(r"(yes|yeah|ok|okay|sure|please do)\b", ask.lower()):
            return _call("type", ref=field["ref"], use_saved=True)
        if field:
            return _call("ask_user", question=f"What should I put for {field.get('name')}?")
    if asked or offered or _FILL_FORM.search(ask.lower()):
        return _next_field(page, results)

    steps = [s for s in re.split(r"\s+(?:and then|then|and)\s+", ask) if s.strip()]
    if done < len(steps):
        return _step(steps[done].strip(" .!?"), page)
    return _say(_summary(results, page))


# Planning


def _step(step: str, page: dict) -> list[LLMEvent]:
    text = step.lower()
    if re.search(r"\bgo back\b|\bback a page\b", text):
        return _call("go_back")
    if scroll := re.search(r"\bscroll\b.*?\b(down|up|top|bottom)\b", text):
        return _call("scroll", direction=scroll.group(1))
    if tab := re.search(r"\bswitch to (?:the )?(.+?)(?: tab)?$", text):
        return _call("switch_tab", query=tab.group(1))
    if site := re.search(r"\bopen (\S+\.\S+)", text):
        return _call("open_url", url=site.group(1))
    if web := _WEB_SEARCH.search(text):
        return _call("web_search", query=web.group(1))
    # "Search for amazon.in" on a page with no search box, such as the new-tab page.
    wanted = _SEARCH_FOR.search(text)
    if wanted and not any(n.get("role") == "searchbox" for n in page.get("nodes", [])):
        words = wanted.group(1)
        if re.fullmatch(r"[\w-]+(\.[\w-]+)+", words):
            return _call("open_url", url=words)
        return _call("web_search", query=words)
    if moved := _MOVE_TO.search(text):
        field = _find(page, moved.group(1), (*_FIELDS, "combobox", "heading"))
        if field:
            return _call("focus", ref=field["ref"])
    typed = re.search(
        r"^(?:type|enter|write|put) (.+?) (?:in|into|in to) (?:the )?(.+?)(?: field| box)?$",
        step,
        re.IGNORECASE,
    )
    if typed:
        field = _find(page, typed.group(2), _FIELDS)
        if field:
            return _call("type", ref=field["ref"], text=typed.group(1))
        return _say(f"I can't find a field called {typed.group(2)} on this page.")
    chosen = re.search(
        r"^(?:select|choose|pick) (.+?) (?:for|in|from|as) (?:the )?(.+?)$", step, re.IGNORECASE
    )
    if chosen:
        box = _find(page, chosen.group(2), ("combobox", "listbox"))
        if box:
            return _call("select", ref=box["ref"], option=chosen.group(1))
        return _say(f"I can't find a list called {chosen.group(2)} on this page.")
    control = _find(page, step, _CONTROLS)
    if control:
        return _call("click", ref=control["ref"])
    return _say(f"I can't find anything for {step} on this page.")


def _next_field(page: dict, results: Sequence[str]) -> list[LLMEvent]:
    """Asks for the next empty field, hands over a private one, or submits the form."""
    for node in page.get("nodes", []):
        if node.get("role") not in _FIELDS or node.get("state", {}).get("disabled"):
            continue
        if node.get("sensitive"):
            if not node.get("state", {}).get("filled"):
                return _call("type", ref=node["ref"], text="")
        elif not node.get("value"):
            if node.get("state", {}).get("saved"):
                question = f"I have your saved {node.get('name')}. Shall I use it?"
                return _call("ask_user", question=question)
            return _call("ask_user", question=f"What should I put for {node.get('name')}?")
    buttons = [n for n in page.get("nodes", []) if n.get("role") == "button"]
    submit = next((b for b in buttons if _SUBMIT.search(b.get("name", ""))), None)
    if submit is None and buttons:
        submit = buttons[-1]
    if submit is None:
        return _say(_summary(results, page))
    if any(r.startswith("Done: click") for r in results):
        return _say(_summary(results, page))
    return _call("click", ref=submit["ref"])


def _find(page: dict, wanted: str, roles: Sequence[str]) -> dict | None:
    """The node of one of `roles` whose name shares the most words with `wanted`."""
    words = {w for w in re.findall(r"[a-z0-9]+", wanted.lower()) if w not in _STOPWORDS}
    best: tuple[int, dict] | None = None
    for node in page.get("nodes", []):
        if node.get("role") not in roles:
            continue
        name = set(re.findall(r"[a-z0-9]+", str(node.get("name", "")).lower()))
        score = len(words & name)
        if score and (best is None or score > best[0]):
            best = (score, node)
    return best[1] if best else None


# Speaking


def _report(prompt: str, page: dict) -> str:
    control = re.search(r'"((?:[^"\\]|\\.)*)" (?:has now been \w+|did not work)', prompt)
    name = control.group(1) if control else "it"
    if "did not work" in prompt:
        return f"I could not press {name}. {_where(page)}"
    return f"Done. I pressed {name}. {_where(page)}"


def _summary(results: Sequence[str], page: dict) -> str:
    sentences = []
    for action, name, detail in _DONE.findall("\n".join(results)):
        target = json.loads(name) if name else ""
        if action == "click":
            sentences.append(f"I pressed {target}.")
        elif action == "type":
            sentences.append(f"I typed {detail} into {target}.")
        elif action == "select":
            sentences.append(f"I chose {detail} for {target}.")
        elif action == "scroll":
            sentences.append(f"I scrolled {detail or 'the page'}.")
        elif action == "go_back":
            sentences.append("I went back a page.")
        elif action == "switch_tab":
            sentences.append(f"I switched to the tab {target}.")
        elif action == "open_url":
            sentences.append(f"I opened {detail}.")
        elif action == "focus":
            sentences.append(f"I moved to {target}.")
        elif action == "web_search":
            sentences.append(f"I searched the web for {detail}.")
    if not sentences:
        return "There was nothing for me to do."
    return f"Done. {' '.join(sentences)} {_where(page)}"


def _where(page: dict) -> str:
    heading = next((n.get("name") for n in page.get("nodes", []) if n.get("role") == "heading"), "")
    title = f"This page is titled {page.get('title') or 'untitled'}."
    return f"{title} Its main heading is {heading}." if heading else title


# Messages


def _say(text: str) -> list[LLMEvent]:
    reply = f"CONFIDENCE: high\n{text}"
    return [*(TextDelta(word) for word in re.findall(r"\S+\s*", reply)), StreamEnd()]


def _call(name: str, **arguments: Any) -> list[LLMEvent]:
    return [
        ToolCallRequest(ToolCall(id=f"act_{name}", name=name, arguments=arguments)),
        StreamEnd("tool_use"),
    ]


def _text(message: Message | None) -> str:
    if message is None:
        return ""
    if isinstance(message.content, str):
        return message.content
    return " ".join(getattr(part, "text", "") for part in message.content)


def _last(messages: Sequence[Message], role: str) -> Message | None:
    return next((m for m in reversed(messages) if m.role == role), None)


def _latest_page(messages: Sequence[Message]) -> dict:
    for message in reversed(messages):
        blocks = _PAGE_DATA.findall(_text(message))
        if blocks:
            return json.loads(blocks[-1])
    return {}


def _previous_reply(messages: Sequence[Message]) -> str:
    """What Assista said at the end of the turn before this one."""
    spoken = [m for m in messages if m.role == "assistant" and not m.tool_calls]
    return _text(spoken[-1]) if spoken else ""
