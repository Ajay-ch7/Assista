"""Stands in for the Advisor's model in tests: finds the charges in the page data, adds
them up and compares the sum with the page's own total. No network and no key."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator

from app.llm.base import LLMEvent, LLMRequest, StreamEnd, TextDelta

_PAGE_DATA = re.compile(r"<page_data_\w+>\n(.*?)\n</page_data_\w+>", re.DOTALL)
_MONEY = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(rupees|dollars|euros|pounds)", re.IGNORECASE)
_TOTAL = re.compile(r"\btotal\b", re.IGNORECASE)


def advise(request: LLMRequest) -> list[LLMEvent]:
    message = request.messages[-1]
    prompt = message.content if isinstance(message.content, str) else ""
    match = _PAGE_DATA.search(prompt)
    page = json.loads(match.group(1)) if match else {}
    return _say(_total_cost(page))


def _total_cost(page: dict) -> str:
    total: str | None = None
    charges: list[tuple[str, float, str]] = []
    for line, ticked in _lines(page):
        money = _MONEY.search(line)
        if not money:
            continue
        amount = f"{money.group(1)} {money.group(2)}"
        if _TOTAL.search(line):
            total = total or amount
        elif ticked:
            charges.append((line.rstrip("."), _number(money.group(1)), money.group(2)))
    if not charges and total is None:
        return "The page shows no prices."
    unit = charges[0][2] if charges else ""
    added = _format(sum(amount for _, amount, _ in charges), unit)
    named = "; ".join(line for line, _, _ in charges)
    if total is None:
        return f"The page shows no total. The charges I can see add up to {added}: {named}."
    if charges and _number(total.split()[0]) != sum(amount for _, amount, _ in charges):
        return (
            f"CONFIDENCE: low\nThe page says the total is {total}, but the charges I can see "
            f"add up to {added}, so they do not match: {named}."
        )
    return f"You will pay {total} in total. The charges are: {named}."


def _lines(page: dict) -> Iterator[tuple[str, bool]]:
    """Each line of the page that could hold a charge, and whether it counts: a box that
    is not ticked is only an option."""
    for table in page.get("tables", []):
        for row in table.get("rows", []):
            yield " ".join(row), True
    for node in page.get("nodes", []):
        if node.get("role") in ("checkbox", "switch"):
            yield node.get("name", ""), bool(node.get("state", {}).get("checked"))
        elif node.get("text"):
            yield node["text"], True


def _number(text: str) -> float:
    return float(text.replace(",", ""))


def _format(amount: float, unit: str) -> str:
    whole = int(amount) if amount == int(amount) else amount
    return f"{whole:,} {unit}".strip()


def _say(text: str) -> list[LLMEvent]:
    reply = text if text.startswith("CONFIDENCE") else f"CONFIDENCE: high\n{text}"
    return [*(TextDelta(word) for word in re.findall(r"\S+\s*", reply)), StreamEnd()]
