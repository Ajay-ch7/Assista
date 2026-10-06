"""Phase 3 in text mode: the Actor navigates, fills a form one field at a time, hands
private fields to the user, and submits only after the gate's read-back and a yes."""

import json
import re

from app.agents.actor import ROLE
from app.config import REPO_ROOT, Settings
from app.confirmation import WORDS, parse_confirmation
from app.llm.base import StreamEnd, TextDelta, ToolCall, ToolCallRequest
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from tests.harness import FORM_SNAPSHOT, SHOP_SNAPSHOT, FakePage, session

CONFIRMED_PAGE = {
    "url": "http://127.0.0.1:8787/form.html",
    "title": "Order placed - Riverside Outfitters",
    "nodes": [
        {"ref": "e1", "role": "heading", "name": "Thank you, Asha Rao", "state": {"level": 1}}
    ],
}


def tool_calls(result) -> list[tuple]:
    return [(m["name"], m.get("ref"), m["args"]) for m in result.of_type("tool_call")]


def all_frames(*results) -> str:
    return json.dumps([m for result in results for m in result.messages])


# F05 voice navigation


def test_a_click_is_sent_as_a_tool_call_on_the_current_snapshot():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        result = client.ask("press add to cart", page=page)
    (call,) = result.of_type("tool_call")
    assert (call["name"], call["ref"], call["args"]) == ("click", "e5", {})
    assert call["snapshot_id"] == "page-1"
    assert page.pressed == ["Add to cart"]
    assert result.speech[0] == "Done."
    assert "I pressed Add to cart." in result.speech
    assert result.types[-1] == "done"


def test_steps_run_in_order_each_on_a_fresh_snapshot():
    page = FakePage(FORM_SNAPSHOT)
    with session() as client:
        result = client.ask("press add gift wrap and open the returns policy", page=page)
    assert page.pressed == ["Add gift wrap", "Returns policy"]
    first, second = result.of_type("tool_call")
    assert (first["snapshot_id"], second["snapshot_id"]) == ("page-1", "page-2")
    assert result.types.count("request_snapshot") == 3


def test_scrolling_going_back_and_typing_use_their_tools():
    page = FakePage(FORM_SNAPSHOT)
    with session() as client:
        scrolled = client.ask("scroll down", page=page)
        back = client.ask("go back", page=page)
        typed = client.ask("type Pune into the city field", page=page)
    assert tool_calls(scrolled) == [("scroll", None, {"direction": "down"})]
    assert tool_calls(back) == [("go_back", None, {})]
    assert tool_calls(typed) == [("type", "e4", {"text": "Pune"})]
    assert "I typed Pune into City." in typed.speech


def test_something_that_is_not_on_the_page_is_not_guessed():
    page = FakePage(SHOP_SNAPSHOT)
    with session() as client:
        result = client.ask("press the unsubscribe button", page=page)
    assert result.of_type("tool_call") == []
    assert "can't find" in " ".join(result.speech)


def test_a_failed_action_is_spoken():
    page = FakePage(SHOP_SNAPSHOT)
    page.run = lambda call: {"ok": False, "error": "disabled"}  # type: ignore[method-assign]
    with session() as client:
        result = client.ask("press add to cart", page=page)
    assert "That did not work: that control is disabled." in " ".join(result.speech)


def test_an_action_the_page_never_answers_ends_in_words_not_a_hang():
    script = [
        [ToolCallRequest(ToolCall("c1", "click", {"ref": "e5"})), StreamEnd("tool_use")],
        [TextDelta("The page did not respond."), StreamEnd()],
    ]
    llm = MockLLM(script=script)
    settings = Settings()
    deps = Deps(settings=settings, respond=model_responder(settings, llm), action_timeout=0.05)
    with session(deps) as client:
        turn_id = client.next_turn_id()
        client.send({"type": "transcript", "turn_id": turn_id, "text": "press add to cart"})
        result = None
        while result is None or result["type"] != "done":
            result = json.loads(client.ws.receive()["text"])
            if result["type"] == "request_snapshot":
                reply = {"type": "snapshot", "turn_id": turn_id, "snapshot": SHOP_SNAPSHOT}
                client.send(reply)
    tool_message = llm.specialist_requests[1].messages[-1]
    assert tool_message.content.startswith("Failed: the page did not answer in time.")


# F06 form filling, F07 gate, F19 private fields


def fill_form(client, page):
    """Fills the demo form by voice up to the gate. Returns every turn's result."""
    turns = [client.ask("fill in the form", page=page)]
    turns.append(client.ask("Asha Rao", page=page))
    turns.append(client.ask("Pune", page=page))
    return turns


def test_the_form_is_filled_one_field_at_a_time():
    page = FakePage()
    with session() as client:
        start, name, city = fill_form(client, page)
    assert start.speech == ["What should I put for Full name?"]
    assert start.of_type("tool_call") == []
    assert tool_calls(name) == [("type", "e3", {"text": "Asha Rao"})]
    assert name.speech == ["What should I put for City?"]
    # After the city, the next field is private: it gets focus, and nothing is typed.
    assert tool_calls(city) == [("type", "e4", {"text": "Pune"}), ("type", "e5", {"text": ""})]
    assert "Type it on your keyboard, then say continue." in city.speech


def test_a_private_field_is_never_typed_by_the_assistant_and_its_value_never_travels():
    page = FakePage()
    with session() as client:
        turns = fill_form(client, page)
        page.type_privately("One-time code")
        turns.append(client.ask("continue", page=page))
    typed = [c for c in page.calls if c["name"] == "type"]
    assert [c["args"]["text"] for c in typed] == ["Asha Rao", "Pune", ""]
    assert "493817" not in all_frames(*turns)


def test_submitting_is_held_and_read_back_in_full():
    page = FakePage()
    with session() as client:
        fill_form(client, page)
        page.type_privately("One-time code")
        result = client.ask("continue", page=page)
    assert tool_calls(result) == [("click", "e8", {})]
    assert page.pressed == []
    assert result.speech == [
        "I am about to press Place order.",
        "Order total: 4,598 rupees.",
        "Full name is Asha Rao.",
        "City is Pune.",
        "One-time code is entered.",
        "Shall I go ahead?",
    ]
    (request,) = result.of_type("confirm_request")
    assert request["confirm_id"] == page.held["confirm_id"]
    assert request["text"].startswith("I am about to press Place order.")
    assert request["text"].endswith("Shall I go ahead?")
    assert "CONFIDENCE" not in request["text"]


def held_form(client) -> FakePage:
    page = FakePage()
    page.after_submit = CONFIRMED_PAGE
    fill_form(client, page)
    page.type_privately("One-time code")
    client.ask("continue", page=page)
    return page


def test_yes_runs_the_held_action_and_the_outcome_is_spoken():
    with session() as client:
        page = held_form(client)
        result = client.ask("yes", page=page)
    assert page.pressed == ["Place order"]
    # The backend sent no tool call of its own: the extension released the action.
    assert result.of_type("tool_call") == []
    assert result.types[:2] == ["transcript_final", "request_snapshot"]
    assert result.speech == [
        "Done.",
        "I pressed Place order.",
        "This page is titled Order placed - Riverside Outfitters.",
        "Its main heading is Thank you, Asha Rao.",
    ]


def test_no_leaves_the_action_undone():
    with session() as client:
        page = held_form(client)
        result = client.ask("No thanks.", page=page)
        after = client.ask("yes", page=page)
    assert page.pressed == []
    assert result.speech == ["Okay.", "I have not pressed Place order."]
    assert result.types == ["transcript_final", "speak_text", "speak_text", "done"]
    # The hold is over: a later yes is an ordinary request, not a release.
    assert page.pressed == []
    assert after.of_type("tool_call") == []


def test_another_request_drops_the_held_action_and_says_so():
    with session() as client:
        page = held_form(client)
        result = client.ask("what is this page?", page=page)
        after = client.ask("yes", page=page)
    assert result.speech[0] == "I have not pressed Place order."
    assert "This page is titled Delivery details - Riverside Outfitters." in result.speech
    assert page.pressed == []
    assert after.of_type("tool_call") == []


def test_a_local_command_keeps_the_action_held():
    with session() as client:
        page = held_form(client)
        repeat = client.ask("repeat that", page=page)
        result = client.ask("yes", page=page)
    assert repeat.types == ["transcript_final", "done"]
    assert page.pressed == ["Place order"]
    assert result.speech[:2] == ["Done.", "I pressed Place order."]


def test_a_yes_the_extension_does_not_back_runs_nothing():
    """The backend cannot release an action by itself: without the extension's own
    `confirm`, a yes ends in an error and nothing is pressed."""
    with session(Deps(settings=Settings(llm_provider="mock"), confirm_timeout=0.05)) as client:
        page = held_form(client)
        page.asked = False  # The panel never saw the confirm_request.
        result = client.ask("yes", page=page)
    assert page.pressed == []
    assert result.error["code"] == "confirm_lost"


def test_a_confirm_for_another_action_is_not_accepted():
    with session() as client:
        page = held_form(client)
        page.held["confirm_id"] = "something-else"
        result = client.ask("yes", page=page)
    assert result.speech == ["Okay.", "I have not pressed Place order."]


# The Actor's prompt and model plumbing


def test_the_actor_gets_the_tools_and_page_as_data():
    llm = MockLLM()
    settings = Settings()
    with session(Deps(settings=settings, respond=model_responder(settings, llm))) as client:
        client.ask("press add to cart", page=FakePage(SHOP_SNAPSHOT))
    first, second = llm.specialist_requests
    assert first.system.count("You are the Actor.") == 1
    assert [tool.name for tool in first.tools] == [
        "click",
        "type",
        "select",
        "scroll",
        "go_back",
        "switch_tab",
        "open_url",
        "ask_user",
    ]
    assert "4,499" in first.messages[-1].content
    assert "4,499" not in first.system
    # The tool result carries what was done and the page as it is now, as a data block.
    tool_message = second.messages[-1]
    assert tool_message.role == "tool"
    assert tool_message.content.startswith('Done: click on button "Add to cart"')
    assert re.search(r"The page now:\n<page_data_[0-9a-f]{16}>\n", tool_message.content)


def test_the_model_cannot_act_after_an_action_is_held():
    """Whatever the model asks for once the gate holds an action, nothing more runs."""
    eager = [
        ToolCallRequest(ToolCall("c1", "click", {"ref": "e8"})),
        ToolCallRequest(ToolCall("c2", "click", {"ref": "e7"})),
        StreamEnd("tool_use"),
    ]
    again = [
        TextDelta("I will press it now."),
        ToolCallRequest(ToolCall("c3", "click", {"ref": "e8"})),
        StreamEnd("tool_use"),
    ]
    llm = MockLLM(script=[eager, again])
    settings = Settings()
    page = FakePage()
    with session(Deps(settings=settings, respond=model_responder(settings, llm))) as client:
        result = client.ask("place the order", page=page)
    assert [c["ref"] for c in page.calls] == ["e8"]
    assert page.pressed == []
    assert result.of_type("confirm_request")[0]["text"] == "I will press it now."
    held_round = llm.specialist_requests[1]
    assert held_round.tools == []
    assert [m.content.split(":")[0] for m in held_round.messages[-2:]] == ["HELD", "Not run"]


def test_a_silent_model_still_gets_a_read_back():
    script = [
        [ToolCallRequest(ToolCall("c1", "click", {"ref": "e8"})), StreamEnd("tool_use")],
        [StreamEnd()],
    ]
    llm = MockLLM(script=script)
    settings = Settings()
    with session(Deps(settings=settings, respond=model_responder(settings, llm))) as client:
        result = client.ask("place the order", page=FakePage())
    assert result.speech == ['I am about to press "Place order".', "Shall I go ahead?"]
    assert result.of_type("confirm_request")[0]["text"].endswith("Shall I go ahead?")


def test_the_prompt_states_the_safety_rules():
    assert "Never ask the user to say the value" in ROLE
    assert "one field at a time" in ROLE
    assert "Shall I go ahead?" in ROLE
    assert "Do not claim that anything was submitted" in ROLE


# Yes and no


def test_the_confirmation_words_match_the_extension():
    shared = REPO_ROOT / "extension" / "src" / "shared" / "confirmation.json"
    assert {k: list(v) for k, v in WORDS.items()} == json.loads(shared.read_text(encoding="utf-8"))


def test_only_a_clear_answer_counts():
    assert parse_confirmation("Yes, go ahead.") is True
    assert parse_confirmation("Okay") is True
    assert parse_confirmation("No thanks") is False
    assert parse_confirmation("Don't.") is False
    assert parse_confirmation("yes and buy two more") is None
    assert parse_confirmation("what is the total?") is None
    assert parse_confirmation("") is None
