"""P5.2 in text mode: the Watcher sets up, lists and cancels watches from speech."""

from app.agents.watcher import ROLE
from app.config import Settings
from app.llm.base import StreamEnd, TextDelta, ToolCall, ToolCallRequest
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from tests.harness import SHOP_SNAPSHOT, FakePage, session


def tool_calls(result) -> list[tuple]:
    return [(m["name"], m.get("ref"), m["args"]) for m in result.of_type("tool_call")]


def test_a_watch_is_set_on_the_element_that_holds_the_value():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        result = client.ask("tell me when the price drops", page=page)
    assert tool_calls(result) == [
        (
            "set_watch",
            "e4",
            {
                "condition": "decreases",
                "label": "the price",
                "alert": "The price changed. It now says: {value}",
            },
        )
    ]
    assert result.of_type("tool_call")[0]["snapshot_id"] == "page-1"
    assert " ".join(result.speech) == (
        "I am watching the price. Right now it says: Price: 4,499 rupees. In stock. "
        "I will tell you when it goes down. "
        "This works for as long as the page stays open in a tab."
    )
    assert [w["label"] for w in page.watches] == ["the price"]


def test_thresholds_and_wording_reach_the_tool():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        below = client.ask("watch the price and tell me when it goes below 4,000", page=page)
        stock = client.ask("let me know when the stock says in stock", page=page)
    assert below.of_type("tool_call")[0]["args"]["condition"] == "below"
    assert below.of_type("tool_call")[0]["args"]["value"] == "4000"
    assert "I will tell you when it goes below 4000." in " ".join(below.speech)
    assert stock.of_type("tool_call")[0]["args"]["condition"] == "contains"


def test_the_watches_are_listed_from_the_device():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        empty = client.ask("what are you watching?", page=page)
        client.ask("tell me when the price drops", page=page)
        listed = client.ask("what are you watching?", page=page)
    assert empty.speech == ["I am not watching anything at the moment."]
    assert tool_calls(listed) == [("list_watches", None, {})]
    said = " ".join(listed.speech)
    assert said.startswith("I am watching one thing. the price on Trail Backpack 30L")
    assert said.endswith("I will tell you when it goes down.")


def test_a_watch_is_cancelled_by_name():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        client.ask("tell me when the price drops", page=page)
        stopped = client.ask("stop watching the price", page=page)
        again = client.ask("stop watching the price", page=page)
    assert tool_calls(stopped) == [("cancel_watch", None, {"query": "price"})]
    assert stopped.speech == ["I have stopped watching the price."]
    assert page.watches == []
    assert again.speech == ["I am not watching anything like that."]


def test_something_the_page_does_not_show_is_not_watched():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        result = client.ask("tell me when the delivery date changes", page=page)
    assert result.of_type("tool_call") == []
    assert "nothing to watch" in " ".join(result.speech)
    assert page.watches == []


def test_the_user_hears_what_the_extension_did_not_what_the_model_says():
    """A watch that failed is never announced as set, whatever the model writes."""
    script = [
        [
            TextDelta("I am now watching the price for you."),
            ToolCallRequest(ToolCall("c1", "set_watch", {"ref": "e99", "condition": "changes"})),
            StreamEnd("tool_use"),
        ]
    ]
    llm = MockLLM(script=script)
    settings = Settings()
    page = FakePage(SHOP_SNAPSHOT)
    with session(Deps(settings=settings, respond=model_responder(settings, llm))) as client:
        result = client.ask("tell me when the price drops", page=page)
    said = " ".join(result.speech)
    assert said.startswith("I could not set up that watch: the page changed while I was setting")
    assert "now watching" not in said
    assert page.watches == []


def test_the_prompt_keeps_private_fields_out():
    assert "Never watch a password, code or card field" in ROLE
    assert "You are the Watcher." in ROLE
