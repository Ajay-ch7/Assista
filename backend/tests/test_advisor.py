"""Advisor: the total cost, from the page snapshot, in text mode."""

import copy

from app.agents.advisor import Advisor, preticked_warning, rules_note
from app.agents.base import TurnContext
from app.config import Settings
from app.llm.base import StreamEnd, TextDelta
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from app.protocol import PageSnapshot
from tests.harness import CHECKOUT_SNAPSHOT, SHOP_SNAPSHOT, session


def session_with(llm: MockLLM):
    config = Settings()
    return session(Deps(settings=config, respond=model_responder(config, llm)))


def advisor_request(text, snapshot=CHECKOUT_SNAPSHOT):
    ctx = TurnContext(
        text=text,
        snapshot=PageSnapshot.model_validate(snapshot),
        verbosity="normal",
        private_mode=False,
    )
    return Advisor(MockLLM()).build_request(ctx)


def test_the_advisor_is_told_to_add_every_charge_and_say_the_total_first():
    system = advisor_request("what will I pay?").system
    assert "You are the Advisor." in system
    assert "Add the charges up yourself" in system
    assert "Say the final amount first" in system
    assert "including small print" in system
    assert "say both amounts and that they do not match" in system
    assert "Never guess an amount" in system


def test_the_page_reaches_the_advisor_as_data_only():
    request = advisor_request("what will I pay?")
    assert "4,946" not in request.system
    (message,) = request.messages
    assert message.content.startswith("<page_data_")
    assert "convenience fee of 49 rupees" in message.content
    assert message.content.endswith("The user's spoken request: what will I pay?")


def test_the_total_is_spoken_with_every_charge():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("what is the total?", snapshot=CHECKOUT_SNAPSHOT)
    speech = " ".join(result.speech)
    assert speech.startswith("You will pay 4,946 rupees in total.")
    for charge in ("4,499 rupees", "99 rupees", "Protection Plan for 299", "fee of 49 rupees"):
        assert charge in speech
    assert "Email me" not in speech
    assert result.types[-1] == "done"


def test_a_total_that_does_not_add_up_is_spoken_with_doubt():
    wrong = copy.deepcopy(CHECKOUT_SNAPSHOT)
    wrong["nodes"][8]["text"] = "Total to pay: 4,598 rupees"
    with session_with(MockLLM()) as client:
        result = client.ask("how much are the fees?", snapshot=wrong)
    assert result.speech[0] == "I'm not sure about this."
    assert "add up to 4,946 rupees, so they do not match" in " ".join(result.speech)


def test_a_page_without_a_total_says_so():
    with session_with(MockLLM()) as client:
        result = client.ask("what is the total cost?", snapshot=SHOP_SNAPSHOT)
    assert result.speech[0] == "The page shows no total."


# Tricks (F14)


def test_the_box_the_page_ticked_is_announced_by_code_after_the_answer():
    with session_with(MockLLM()) as client:
        result = client.ask("what is the total?", snapshot=CHECKOUT_SNAPSHOT)
    assert result.speech[-2:] == [
        "Watch out: the page ticked Add Protection Plan for 299 rupees for you.",
        "Untick it if you don't want it.",
    ]


def test_the_exit_check_hidden_fee_pre_ticked_box_and_true_total():
    """Phase 4 exit check, in text mode: the hidden fee and the pre-ticked box are both
    announced, and the spoken total matches the page."""
    with session_with(MockLLM()) as client:
        result = client.ask("how much will I pay?", snapshot=CHECKOUT_SNAPSHOT)
    speech = " ".join(result.speech)
    assert "You will pay 4,946 rupees in total." in speech
    assert "Easy to miss, outside the order summary: Prices include a convenience fee" in speech
    assert "the page ticked Add Protection Plan for 299 rupees for you" in speech


def test_the_warning_is_spoken_even_when_the_model_says_nothing_of_it():
    llm = MockLLM(script=[[TextDelta("CONFIDENCE: high\nYou will pay 4,946 rupees."), StreamEnd()]])
    with session_with(llm) as client:
        result = client.ask("what is the total?", snapshot=CHECKOUT_SNAPSHOT)
    assert result.speech[0] == "You will pay 4,946 rupees."
    assert result.speech[1].startswith("Watch out: the page ticked Add Protection Plan")


def test_several_ticked_boxes_are_named_together():
    page = copy.deepcopy(CHECKOUT_SNAPSHOT)
    page["rules"]["preticked"] = ["e7", "e8"]
    snapshot = PageSnapshot.model_validate(page)
    assert preticked_warning(snapshot) == (
        "Watch out: the page ticked 2 boxes for you: Add Protection Plan for 299 rupees and "
        "Email me about new arrivals. Untick any you don't want."
    )


def test_no_ticked_boxes_means_no_warning_and_no_rules_note():
    snapshot = PageSnapshot.model_validate(SHOP_SNAPSHOT)
    assert preticked_warning(snapshot) == ""
    assert rules_note(snapshot) == ""
    with session_with(MockLLM()) as client:
        result = client.ask("what is the total cost?", snapshot=SHOP_SNAPSHOT)
    assert not any("Watch out" in sentence for sentence in result.speech)


def test_the_model_is_told_what_the_rule_checks_found_and_what_to_warn_about():
    request = advisor_request("is this page trying to trick me?")
    system = request.system
    assert "Pressure to hurry" in system
    assert "shames the user for saying no" in system
    assert "do not warn about them yourself" in system
    content = request.messages[0].content
    note = content[content.index("</page_data_") :]
    assert "found 1 box(es) ticked in advance and 0 countdown(s)" in note


def test_pressure_and_shaming_wording_are_pointed_out():
    with session_with(MockLLM()) as client:
        result = client.ask("is there a catch on this page?", snapshot=CHECKOUT_SNAPSHOT)
    speech = " ".join(result.speech)
    assert "Only 2 left in stock!" in speech
    assert "No thanks, I don't care about protecting my gear" in speech
    assert "Watch out: the page ticked Add Protection Plan" in speech
