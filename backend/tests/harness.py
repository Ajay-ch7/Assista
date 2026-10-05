"""Text-mode harness: drives a session over the WebSocket the way the extension does,
with no browser, microphone or speaker."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import Deps, create_app

SHOP_SNAPSHOT: dict[str, Any] = {
    "url": "http://127.0.0.1:8787/shop.html",
    "title": "Trail Backpack 30L - Riverside Outfitters",
    "snapshot_id": "snap-1",
    "nodes": [
        {"ref": "e1", "role": "navigation", "name": "Main", "text": ""},
        {"ref": "e2", "role": "link", "name": "Tents", "text": ""},
        {
            "ref": "e3",
            "role": "heading",
            "name": "Trail Backpack 30L",
            "text": "",
            "state": {"level": 1},
        },
        {"ref": "e4", "role": "paragraph", "name": "", "text": "Price: 4,499 rupees. In stock."},
        {"ref": "e5", "role": "button", "name": "Add to cart", "text": ""},
        {"ref": "e6", "role": "textbox", "name": "Email", "text": "", "value": "asha@example.com"},
        {
            "ref": "e7",
            "role": "textbox",
            "name": "Password",
            "text": "",
            "sensitive": True,
            "value": None,
        },
    ],
    "tables": [],
    "images": [{"ref": "i1", "alt": "A green backpack", "width": 400, "height": 300}],
    "rules": {"preticked": [], "countdowns": []},
    "flags": {"has_canvas": False, "thin": False, "clutter_removed": 0, "hidden_text_removed": 1},
}

NO_REPLY = object()
"""Pass as `snapshot` to leave request_snapshot unanswered."""


@dataclass
class TurnResult:
    messages: list[dict[str, Any]] = field(default_factory=list)
    audio: list[bytes] = field(default_factory=list)

    def of_type(self, kind: str) -> list[dict[str, Any]]:
        return [m for m in self.messages if m["type"] == kind]

    @property
    def types(self) -> list[str]:
        return [m["type"] for m in self.messages]

    @property
    def speech(self) -> list[str]:
        return [m["text"] for m in self.of_type("speak_text")]

    @property
    def error(self) -> dict[str, Any] | None:
        errors = self.of_type("error")
        return errors[0] if errors else None


class TextModeClient:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self._turns = 0

    def next_turn_id(self) -> str:
        self._turns += 1
        return f"turn-{self._turns}"

    def send(self, message: dict[str, Any]) -> None:
        self.ws.send_text(json.dumps(message))

    def ask(self, text: str, snapshot: Any = SHOP_SNAPSHOT, error: str | None = None) -> TurnResult:
        """Sends one text-mode turn and plays the extension's part until it ends."""
        turn_id = self.next_turn_id()
        self.send({"type": "transcript", "turn_id": turn_id, "text": text})
        return self.finish(turn_id, snapshot, error)

    def finish(
        self, turn_id: str, snapshot: Any = SHOP_SNAPSHOT, error: str | None = None
    ) -> TurnResult:
        """Collects the turn's messages, answering request_snapshot, until done or error."""
        result = TurnResult()
        while True:
            frame = self.ws.receive()
            if frame.get("bytes") is not None:
                result.audio.append(frame["bytes"])
                continue
            msg = json.loads(frame["text"])
            result.messages.append(msg)
            if msg["type"] == "request_snapshot" and snapshot is not NO_REPLY:
                reply = {"type": "snapshot", "turn_id": msg["turn_id"], "snapshot": snapshot}
                if error:
                    reply["error"] = error
                self.send(reply)
            if msg["type"] in ("done", "error") and msg["turn_id"] == turn_id:
                return result


@contextmanager
def session(deps: Deps | None = None, **overrides: Any) -> Iterator[TextModeClient]:
    """Opens one WebSocket session against a fresh app."""
    deps = deps or Deps(settings=Settings(), **overrides)
    with TestClient(create_app(deps)) as client, client.websocket_connect("/ws") as ws:
        yield TextModeClient(ws)
