"""Text-mode harness: drives a session over the WebSocket the way the extension does,
with no browser, microphone or speaker."""

from __future__ import annotations

import base64
import copy
import json
import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi.testclient import TestClient

from app.config import Settings
from app.confirmation import parse_confirmation
from app.local_commands import is_local_command
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
"""Pass as `snapshot` or `screenshot` to leave the request unanswered."""

SCREENSHOT: dict[str, Any] = {"image": "/9j/ZmFrZSBqcGVn", "mime": "image/jpeg"}
"""A stand-in screenshot reply. Pass {"image": None, "error": "..."} for a failed capture."""


FORM_SNAPSHOT: dict[str, Any] = {
    "url": "http://127.0.0.1:8787/form.html",
    "title": "Delivery details - Riverside Outfitters",
    "snapshot_id": "form-0",
    "nodes": [
        {"ref": "e1", "role": "heading", "name": "Delivery details", "state": {"level": 1}},
        {"ref": "e2", "role": "paragraph", "text": "Order total: 4,598 rupees"},
        {"ref": "e3", "role": "textbox", "name": "Full name", "value": ""},
        {"ref": "e4", "role": "textbox", "name": "City", "value": ""},
        {
            "ref": "e5",
            "role": "textbox",
            "name": "One-time code",
            "sensitive": True,
            "value": None,
            "state": {"filled": False},
        },
        {"ref": "e6", "role": "link", "name": "Returns policy"},
        {"ref": "e7", "role": "button", "name": "Add gift wrap"},
        {"ref": "e8", "role": "button", "name": "Place order"},
    ],
}

CHECKOUT_SNAPSHOT: dict[str, Any] = {
    "url": "http://127.0.0.1:8787/checkout.html",
    "title": "Checkout - Riverside Outfitters",
    "snapshot_id": "checkout-1",
    "nodes": [
        {"ref": "e1", "role": "banner", "name": ""},
        {"ref": "e2", "role": "link", "name": "Riverside Outfitters"},
        {"ref": "e3", "role": "main", "name": ""},
        {"ref": "e4", "role": "heading", "name": "Checkout", "state": {"level": 1}},
        {
            "ref": "e5",
            "role": "paragraph",
            "text": "Only 2 left in stock! 14 people are looking at this right now.",
        },
        {"ref": "e6", "role": "heading", "name": "Your order", "state": {"level": 2}},
        {
            "ref": "e7",
            "role": "checkbox",
            "name": "Add Protection Plan for 299 rupees",
            "state": {"checked": True},
        },
        {
            "ref": "e8",
            "role": "checkbox",
            "name": "Email me about new arrivals",
            "state": {"checked": False},
        },
        {"ref": "e9", "role": "paragraph", "text": "Total to pay: 4,946 rupees"},
        {
            "ref": "e10",
            "role": "paragraph",
            "text": "Prices include a convenience fee of 49 rupees.",
        },
        {"ref": "e11", "role": "link", "name": "Continue to delivery"},
        {"ref": "e12", "role": "link", "name": "No thanks, I don't care about protecting my gear"},
    ],
    "tables": [
        {
            "ref": "t1",
            "caption": "Order summary",
            "rows": [
                ["Item", "Price"],
                ["Trail Backpack 30L", "4,499 rupees"],
                ["Standard delivery", "99 rupees"],
            ],
        }
    ],
    "rules": {"preticked": ["e7"], "countdowns": []},
}

TERMS_SNAPSHOT: dict[str, Any] = {
    "url": "http://127.0.0.1:8787/terms.html",
    "title": "Terms of membership - StreamBox",
    "snapshot_id": "terms-1",
    "nodes": [
        {"ref": "e1", "role": "heading", "name": "StreamBox membership terms"},
        {"ref": "e2", "role": "heading", "name": "2. Free trial and billing"},
        {
            "ref": "e3",
            "role": "paragraph",
            "text": "Your membership starts with a 7-day free trial. Unless you cancel before "
            "the trial ends, your membership renews automatically every month and we charge "
            "649 rupees to your saved card each month until you cancel.",
        },
        {"ref": "e4", "role": "heading", "name": "4. Cancelling"},
        {
            "ref": "e5",
            "role": "paragraph",
            "text": "You can cancel only by calling our membership line between 10 am and 4 "
            "pm on weekdays.",
        },
        {"ref": "e6", "role": "heading", "name": "5. Refunds"},
        {
            "ref": "e7",
            "role": "paragraph",
            "text": "All payments are non-refundable. We do not give refunds or credits for "
            "partly used periods.",
        },
        {"ref": "e8", "role": "heading", "name": "7. Disputes"},
        {
            "ref": "e9",
            "role": "paragraph",
            "text": "Any dispute will be settled by binding arbitration, and you give up the "
            "right to take part in a class action.",
        },
    ],
}

_GATED = re.compile(r"\b(pay|buy|place order|submit|confirm|delete|send)\b", re.IGNORECASE)


class FakePage:
    """Plays the extension's part for action tools: a page whose fields can be typed
    into, with the confirmation gate and private fields behaving as the extension's do.

    Every snapshot gets a new id, as in the extension, so stale refs are refused.
    """

    def __init__(self, snapshot: dict[str, Any] = FORM_SNAPSHOT) -> None:
        self._snapshot = copy.deepcopy(snapshot)
        self._version = 0
        self.calls: list[dict[str, Any]] = []
        self.pressed: list[str] = []
        self.held: dict[str, Any] | None = None
        self.asked = False
        self.after_submit: dict[str, Any] | None = None
        """The page shown once a gated control has been pressed."""
        self.unasked: set[str] = set()
        """Controls the extension would hold because the user did not name them."""
        self.saved: dict[str, str] = {}
        """Details saved on the device, by field name. Their fields are marked saved."""
        self.watches: list[dict[str, Any]] = []
        """The watches set, as the extension would summarise them."""

    def snapshot(self) -> dict[str, Any]:
        self._version += 1
        nodes = [
            {**node, "state": {**node.get("state", {}), "saved": True}}
            if node.get("name") in self.saved and node.get("value") == ""
            else node
            for node in self._snapshot["nodes"]
        ]
        return {**self._snapshot, "nodes": nodes, "snapshot_id": f"page-{self._version}"}

    def type_privately(self, name: str) -> None:
        """The user types into a sensitive field themselves."""
        node = next(n for n in self._snapshot["nodes"] if n.get("name") == name)
        node["state"] = {**node.get("state", {}), "filled": True}

    def run(self, call: dict[str, Any]) -> dict[str, Any]:
        """Runs one tool_call and returns the fields of its tool_result."""
        self.calls.append(call)
        self.held, self.asked = None, False
        name, args = call["name"], call.get("args", {})
        if name == "list_watches":
            return {"ok": True, "result": {"action": name, "watches": list(self.watches)}}
        if name == "cancel_watch":
            query = str(args.get("query") or "").lower()
            gone = [w for w in self.watches if query in w["label"].lower()]
            if not gone:
                return {"ok": False, "error": "no_such_watch"}
            self.watches = [w for w in self.watches if w not in gone]
            detail = ", ".join(w["label"] for w in gone)
            return {"ok": True, "result": {"action": name, "detail": detail, "watches": gone}}
        if name in ("go_back", "switch_tab", "open_url", "web_search") or (
            name == "scroll" and "ref" not in call
        ):
            detail = args.get("direction") or args.get("url") or args.get("query")
            return {
                "ok": True,
                "result": {"action": name, **({"detail": detail} if detail else {})},
            }
        if call["snapshot_id"] != f"page-{self._version}":
            return {"ok": False, "error": "stale_ref"}
        node = next((n for n in self._snapshot["nodes"] if n["ref"] == call.get("ref")), None)
        if node is None:
            return {"ok": False, "error": "stale_ref"}
        target = {"role": node["role"], "name": node.get("name", "")}
        if node.get("sensitive"):
            return {"ok": False, "error": "sensitive_field", "result": {"field": target["name"]}}
        if name == "set_watch":
            words = {
                "decreases": "goes down",
                "increases": "goes up",
                "below": f"goes below {args.get('value')}",
                "above": f"goes above {args.get('value')}",
                "contains": f"says {args.get('value')}",
            }
            summary = {
                "id": f"w{len(self.calls)}",
                "label": args.get("label") or target["name"],
                "page": self._snapshot.get("title", ""),
                "condition": words.get(args.get("condition"), "changes"),
                "value": node.get("text") or node.get("value") or target["name"],
            }
            self.watches.append(summary)
            return {
                "ok": True,
                "result": {"action": name, "detail": summary["value"], "watches": [summary]},
            }
        if name == "type" and args.get("use_saved"):
            if target["name"] not in self.saved:
                return {"ok": False, "error": "nothing_saved"}
            args = {"text": self.saved[target["name"]]}
        if name == "type":
            node["value"] = args.get("text", "")
            return {
                "ok": True,
                "result": {"action": name, "target": target, "detail": node["value"]},
            }
        if name == "click" and target["name"] in self.unasked:
            self.held = {
                "confirm_id": f"hold-{len(self.calls)}",
                "call": call,
                "control": target["name"],
            }
            return {
                "ok": False,
                "held_by_gate": True,
                "error": "held_by_gate",
                "result": {
                    "confirm_id": self.held["confirm_id"],
                    "control": target["name"],
                    "reason": "not_requested",
                },
            }
        if name == "click" and _GATED.search(target["name"]):
            self.held = {
                "confirm_id": f"hold-{len(self.calls)}",
                "call": call,
                "control": target["name"],
            }
            return {
                "ok": False,
                "held_by_gate": True,
                "error": "held_by_gate",
                "result": {
                    "confirm_id": self.held["confirm_id"],
                    "control": target["name"],
                    "reason": "risky_control",
                },
            }
        if name == "click":
            self.pressed.append(target["name"])
        return {"ok": True, "result": {"action": name, "target": target}}

    def settle(self, turn_id: str, text: str) -> list[dict[str, Any]]:
        """What the panel sends when the user speaks while an action is held."""
        if is_local_command(text):
            return []
        held, asked = self.held, self.asked
        self.held, self.asked = None, False
        answer = parse_confirmation(text)
        if held is None or not asked or answer is None:
            return []
        confirm = {
            "type": "confirm",
            "turn_id": turn_id,
            "confirm_id": held["confirm_id"],
            "approved": answer,
        }
        if not answer:
            return [confirm]
        self.pressed.append(held["control"])
        if self.after_submit is not None:
            self._snapshot = copy.deepcopy(self.after_submit)
        result = {
            "type": "tool_result",
            "turn_id": turn_id,
            "call_id": held["call"]["call_id"],
            "ok": True,
            "result": {"action": "click", "target": {"role": "button", "name": held["control"]}},
        }
        return [confirm, result]


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

    def ask(
        self,
        text: str,
        snapshot: Any = SHOP_SNAPSHOT,
        error: str | None = None,
        screenshot: Any = SCREENSHOT,
        page: FakePage | None = None,
        document: bytes | dict[str, Any] | None = None,
    ) -> TurnResult:
        """Sends one text-mode turn and plays the extension's part until it ends."""
        turn_id = self.next_turn_id()
        self.send({"type": "transcript", "turn_id": turn_id, "text": text})
        return self.finish(turn_id, snapshot, error, screenshot, page, document)

    def say(
        self, *chunks: bytes, snapshot: Any = SHOP_SNAPSHOT, sample_rate: int = 16000
    ) -> TurnResult:
        """Sends one spoken turn: audio_start, the audio chunks, audio_end."""
        turn_id = self.next_turn_id()
        fmt = {"encoding": "pcm_s16le", "sample_rate": sample_rate, "channels": 1}
        self.send({"type": "audio_start", "turn_id": turn_id, "format": fmt})
        for chunk in chunks:
            self.ws.send_bytes(chunk)
        self.send({"type": "audio_end", "turn_id": turn_id})
        return self.finish(turn_id, snapshot)

    def finish(
        self,
        turn_id: str,
        snapshot: Any = SHOP_SNAPSHOT,
        error: str | None = None,
        screenshot: Any = SCREENSHOT,
        page: FakePage | None = None,
        document: bytes | dict[str, Any] | None = None,
    ) -> TurnResult:
        """Collects the turn's messages, answering the backend's requests for the page,
        until done or error. With `page`, snapshots and action tools go to it. `document`
        is the PDF file sent on request_document, or the reply's fields when it fails."""
        result = TurnResult()
        while True:
            frame = self.ws.receive()
            if frame.get("bytes") is not None:
                result.audio.append(frame["bytes"])
                continue
            msg = json.loads(frame["text"])
            result.messages.append(msg)
            if page is not None:
                if msg["type"] == "transcript_final":
                    for reply in page.settle(msg["turn_id"], msg["text"]):
                        self.send(reply)
                elif msg["type"] == "tool_call":
                    ids = {"turn_id": msg["turn_id"], "call_id": msg["call_id"]}
                    self.send({"type": "tool_result", **ids, **page.run(msg)})
                elif msg["type"] == "confirm_request":
                    page.asked = page.held is not None and (
                        msg["confirm_id"] == page.held["confirm_id"]
                    )
            if msg["type"] == "request_snapshot" and snapshot is not NO_REPLY:
                if page is not None:
                    snapshot = page.snapshot()
                reply = {"type": "snapshot", "turn_id": msg["turn_id"], "snapshot": snapshot}
                if error:
                    reply["error"] = error
                self.send(reply)
            if msg["type"] == "request_screenshot" and screenshot is not NO_REPLY:
                ref = {"ref": msg["ref"]} if msg.get("ref") else {}
                self.send({"type": "screenshot", "turn_id": msg["turn_id"], **ref, **screenshot})
            if msg["type"] == "request_document":
                if isinstance(document, bytes):
                    data = base64.b64encode(document).decode()
                    reply = {"url": snapshot["url"], "data": data, "mime": "application/pdf"}
                else:
                    reply = document or {"data": None, "error": "not_pdf"}
                self.send({"type": "document", "turn_id": msg["turn_id"], **reply})
            if msg["type"] in ("done", "error") and msg["turn_id"] == turn_id:
                return result


@contextmanager
def session(deps: Deps | None = None, **overrides: Any) -> Iterator[TextModeClient]:
    """Opens one WebSocket session against a fresh app, with the mock model."""
    deps = deps or Deps(settings=Settings(llm_provider="mock"), **overrides)
    with TestClient(create_app(deps)) as client, client.websocket_connect("/ws") as ws:
        yield TextModeClient(ws)
