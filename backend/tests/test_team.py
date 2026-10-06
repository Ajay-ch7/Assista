"""The specialist framework: routing, the confidence line, memory and stand-ins."""

import pytest

from app.agents.base import ConfidenceFilter
from app.config import Settings
from app.llm.base import StreamEnd, TextDelta
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from tests.harness import session


def session_with(llm: MockLLM, **settings: str):
    config = Settings(**settings)
    return session(Deps(settings=config, respond=model_responder(config, llm)))


def filtered(*pieces: str) -> tuple[str, str | None]:
    confidence = ConfidenceFilter()
    text = "".join(confidence.feed(piece) for piece in pieces) + confidence.flush()
    return text, confidence.confidence


@pytest.mark.parametrize(
    ("pieces", "text", "level"),
    [
        (["CONFIDENCE: high\nThe page is a shop."], "The page is a shop.", "high"),
        (["CONF", "IDENCE", ": lo", "w\nIt may be a shop."], "It may be a shop.", "low"),
        (["**Confidence:** medium\n\nA shop."], "\nA shop.", "medium"),
        (["Confidence: low. It is a shop."], "It is a shop.", "low"),
        (["The page is a shop."], "The page is a shop.", None),
        (["Confidential files are listed."], "Confidential files are listed.", None),
        (["CONFIDENCE: high"], "", "high"),
        (["A shop.\nCONFIDENCE: low"], "A shop.\n", "low"),
    ],
)
def test_the_confidence_line_is_taken_out(pieces, text, level):
    assert filtered(*pieces) == (text, level)


def test_a_confidence_line_counts_only_at_the_start_of_a_line():
    text, level = filtered("CONFIDENCE: high\nI read: confidence: low\n")
    assert (text, level) == ("I read: confidence: low\n", "high")


def test_the_latest_confidence_line_wins():
    text, level = filtered("CONFIDENCE: high\n", "Let me look.\n", "CONFIDENCE: low\nIt is dim.")
    assert (text, level) == ("Let me look.\nIt is dim.", "low")


def test_speech_is_not_held_back_once_the_line_cannot_be_the_confidence_line():
    confidence = ConfidenceFilter()
    assert confidence.feed("CONFIDENCE: high\nThe pa") == "The pa"
    assert confidence.feed("ge") == "ge"


def scripted(*pieces: str) -> MockLLM:
    return MockLLM(script=[[*(TextDelta(piece) for piece in pieces), StreamEnd()]])


def test_low_confidence_is_spoken_before_the_answer():
    with session_with(scripted("CONFIDENCE: low\n", "It may be a shop.")) as client:
        result = client.ask("where am I?")
    assert result.speech == ["I'm not sure about this.", "It may be a shop."]


def test_low_confidence_stated_late_is_spoken_after_the_answer():
    with session_with(scripted("It may be a shop.\n", "CONFIDENCE: low")) as client:
        result = client.ask("where am I?")
    assert result.speech == ["It may be a shop.", "I'm not sure about that, so please check it."]


@pytest.mark.parametrize("line", ["CONFIDENCE: high\n", "CONFIDENCE: medium\n", ""])
def test_other_confidence_levels_add_nothing(line):
    with session_with(scripted(line, "It is a shop.")) as client:
        result = client.ask("where am I?")
    assert result.speech == ["It is a shop."]


def test_the_spoken_warning_is_remembered_with_the_answer():
    llm = MockLLM(
        script=[
            [TextDelta("CONFIDENCE: low\nIt may be a shop."), StreamEnd()],
            [TextDelta("CONFIDENCE: high\nOK."), StreamEnd()],
        ]
    )
    with session_with(llm) as client:
        client.ask("where am I?")
        client.ask("and now?")
    assert llm.specialist_requests[1].messages[1].content == (
        "I'm not sure about this.\nIt may be a shop."
    )


def test_the_router_runs_on_the_router_model_and_the_reader_on_the_main_model():
    llm = MockLLM()
    with session_with(llm, llm_model="main-model", router_model="small-model") as client:
        result = client.ask("where am I?")
    assert [r.model for r in llm.requests] == ["small-model", "main-model"]
    assert "CONFIDENCE" not in " ".join(result.speech)
    assert result.speech[0].startswith("This page is titled")


def test_cost_questions_go_to_the_advisor():
    llm = MockLLM()
    with session_with(llm) as client:
        client.ask("what is the total cost?")
    (request,) = llm.specialist_requests
    assert "You are the Advisor." in request.system


def test_earlier_exchanges_reach_the_specialist():
    llm = MockLLM(
        script=[
            [TextDelta("CONFIDENCE: high\nIt is a backpack shop."), StreamEnd()],
            [TextDelta("CONFIDENCE: high\nIt costs 4,499 rupees."), StreamEnd()],
        ]
    )
    with session_with(llm) as client:
        client.ask("where am I?")
        client.ask("how much is it?")
    second = llm.specialist_requests[1].messages
    assert [(m.role, m.content) for m in second[:2]] == [
        ("user", "Earlier request: where am I?"),
        ("assistant", "It is a backpack shop."),
    ]
    assert second[2].content.endswith("The user's spoken request: how much is it?")


def test_memory_belongs_to_one_session():
    llm = MockLLM()
    deps = Deps(settings=Settings(), respond=model_responder(Settings(), llm))
    with session(deps) as client:
        client.ask("where am I?")
    with session(deps) as client:
        client.ask("where am I?")
    assert all(len(r.messages) == 1 for r in llm.specialist_requests)
