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


def test_only_the_first_confidence_line_counts():
    text, level = filtered("CONFIDENCE: high\nI read: confidence: low\n")
    assert (text, level) == ("I read: confidence: low\n", "high")


def test_speech_is_not_held_back_once_the_line_cannot_be_the_confidence_line():
    confidence = ConfidenceFilter()
    assert confidence.feed("CONFIDENCE: high\nThe pa") == "The pa"
    assert confidence.feed("ge") == "ge"


def test_the_router_runs_on_the_router_model_and_the_reader_on_the_main_model():
    llm = MockLLM()
    with session_with(llm, llm_model="main-model", router_model="small-model") as client:
        result = client.ask("where am I?")
    assert [r.model for r in llm.requests] == ["small-model", "main-model"]
    assert "CONFIDENCE" not in " ".join(result.speech)
    assert result.speech[0].startswith("This page is titled")


@pytest.mark.parametrize(
    ("text", "reply"),
    [
        ("click add to cart", "I can't click, type or move between pages yet."),
        ("tell me when the price drops", "I can't watch pages for changes yet."),
    ],
)
def test_specialists_from_later_phases_say_what_is_not_possible_yet(text, reply):
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask(text)
    assert reply in " ".join(result.speech)
    assert result.types[-1] == "done"
    assert llm.specialist_requests == []


def test_cost_questions_are_read_from_the_page_until_the_advisor_exists():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("what is the total cost?")
    assert result.speech[0].startswith("This page is titled")


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
