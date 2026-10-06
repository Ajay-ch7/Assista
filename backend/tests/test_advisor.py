"""Advisor: the total cost, from the page snapshot, in text mode."""

import copy

from app.agents.advisor import Advisor
from app.agents.base import TurnContext
from app.config import Settings
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
