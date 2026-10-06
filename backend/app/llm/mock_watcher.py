"""Stands in for the Watcher's model in tests: picks the element to watch and the
condition by keyword. No network and no key."""

from __future__ import annotations

import json
import re

from app.llm.base import LLMEvent, LLMRequest, StreamEnd, TextDelta, ToolCall, ToolCallRequest

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*?)\n</page_data_\w+>", re.DOTALL)
_REQUEST = "The user's spoken request: "
_NUMBER = re.compile(r"(\d[\d,]*(?:\.\d+)?)")
_LIST = re.compile(r"\bwhat\b.*\bwatch|\blist\b.*\bwatch|\bwhich watches\b|\bmy watches\b")
_CANCEL = re.compile(r"\b(?:stop watching|cancel|unwatch|stop the watch|forget)\b\s*(.*)$")
# Words of the request that say how to watch, not what to watch.
_NOT_THE_SUBJECT = set(
    "watch watching tell me when if the a an it is this that page for and of on in to let "
    "know notify alert changes change changed drops drop falls goes go down up below "
    "above under over rises back comes please keep eye any there here".split()
)


def watch(request: LLMRequest) -> list[LLMEvent]:
    prompt = _last_user_text(request)
    ask = prompt.rsplit(_REQUEST, 1)[-1].strip().lower().rstrip(".?!")
    block = _PAGE_DATA.findall(prompt)
    page = json.loads(block[-1]) if block else {}

    if _LIST.search(ask):
        return _call("list_watches")
    if cancel := _CANCEL.search(ask):
        words = [w for w in re.findall(r"[a-z]+", cancel.group(1)) if w not in _NOT_THE_SUBJECT]
        return _call("cancel_watch", **({"query": " ".join(words)} if words else {}))

    subject = [w for w in re.findall(r"[a-z]+", ask) if w not in _NOT_THE_SUBJECT]
    node = _find(page, subject)
    if node is None:
        wanted = " ".join(subject) or "that"
        return _say(f"I can't find {wanted} on this page, so there is nothing to watch.")
    name = subject[0] if subject else "value"
    condition, value = _condition(ask)
    arguments = {
        "ref": node["ref"],
        "condition": condition,
        "label": f"the {name}",
        "alert": f"The {name} changed. It now says: {{value}}",
    }
    if value:
        arguments["value"] = value
    return _call("set_watch", **arguments)


def _condition(ask: str) -> tuple[str, str]:
    amount = _NUMBER.search(ask)
    if amount and re.search(r"\b(below|under|less than)\b", ask):
        return "below", amount.group(1).replace(",", "")
    if amount and re.search(r"\b(above|over|more than)\b", ask):
        return "above", amount.group(1).replace(",", "")
    if re.search(r"\b(drops?|falls?|goes down|cheaper|lower)\b", ask):
        return "decreases", ""
    if re.search(r"\b(rises?|goes up|higher)\b", ask):
        return "increases", ""
    if re.search(r"\bin stock\b|\bavailable\b", ask):
        return "contains", "in stock"
    return "changes", ""


def _find(page: dict, words: list[str]) -> dict | None:
    """The first text of the page that mentions one of the words."""
    for node in page.get("nodes", []):
        text = f"{node.get('text') or ''} {node.get('name') or ''}".lower()
        if node.get("sensitive"):
            continue
        if node.get("role") in ("paragraph", "text", "listitem", "heading"):
            if any(re.search(rf"\b{re.escape(word)}", text) for word in words):
                return node
    return None


def _say(text: str) -> list[LLMEvent]:
    return [TextDelta(f"CONFIDENCE: high\n{text}"), StreamEnd()]


def _call(name: str, **arguments: object) -> list[LLMEvent]:
    call = ToolCall(id=f"watch_{name}", name=name, arguments=dict(arguments))
    return [ToolCallRequest(call), StreamEnd("tool_use")]


def _last_user_text(request: LLMRequest) -> str:
    for message in reversed(request.messages):
        if message.role == "user":
            if isinstance(message.content, str):
                return message.content
            return " ".join(getattr(part, "text", "") for part in message.content)
    return ""
