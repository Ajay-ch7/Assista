"""Tables and charts (F13): tables are read from the snapshot by the Reader, charts from a
screenshot by Vision, and both give the takeaway first."""

from app.agents.base import TurnContext
from app.agents.reader import Reader
from app.agents.vision import ROLE as VISION_ROLE
from app.llm.mock import MockLLM
from app.protocol import PageSnapshot
from tests.harness import session

STATS_SNAPSHOT = {
    "url": "http://127.0.0.1:8787/stats.html",
    "title": "Monsoon report - Valley Weather Office",
    "snapshot_id": "stats-1",
    "nodes": [
        {"ref": "e1", "role": "heading", "name": "Monsoon report 2026", "state": {"level": 1}},
        {"ref": "e2", "role": "heading", "name": "Rainfall by month", "state": {"level": 2}},
        {"ref": "e3", "role": "heading", "name": "Reservoir level", "state": {"level": 2}},
    ],
    "tables": [
        {
            "ref": "t1",
            "caption": "Rainfall in millimetres, June to September",
            "rows": [
                ["Month", "2026", "Ten-year average"],
                ["June", "182", "165"],
                ["July", "341", "290"],
                ["August", "298", "305"],
                ["September", "154", "172"],
            ],
        }
    ],
    # The canvas chart makes the page thin.
    "flags": {"has_canvas": True, "thin": True},
}


def test_the_reader_is_told_to_give_a_tables_takeaway_first():
    ctx = TurnContext(
        text="read the table",
        snapshot=PageSnapshot.model_validate(STATS_SNAPSHOT),
        verbosity="normal",
        private_mode=False,
    )
    system = Reader(MockLLM()).build_request(ctx).system
    assert "Give the takeaway first" in system
    assert "size in rows and columns" in system
    assert "Read at most five rows unless the user asks for all" in system
    assert "Use only the numbers in the table" in system


def test_vision_is_told_to_give_a_charts_takeaway_first_and_admit_rough_values():
    assert "For a chart or graph, give the takeaway first" in VISION_ROLE
    assert "Values read off a picture can be approximate" in VISION_ROLE
    assert "use the table's numbers" in VISION_ROLE


def test_a_table_is_read_from_the_snapshot_even_on_a_thin_page():
    with session() as client:
        result = client.ask("what does the table show?", snapshot=STATS_SNAPSHOT)
    assert "request_screenshot" not in result.types
    assert result.speech[:2] == [
        "July has the highest 2026, 341.",
        "Rainfall in millimetres, June to September has 4 rows and 3 columns: Month, 2026, "
        "Ten-year average.",
    ]
    assert "June: 2026 is 182, Ten-year average is 165." in result.speech


def test_a_chart_is_read_from_a_screenshot():
    with session() as client:
        result = client.ask("what does the chart show?", snapshot=STATS_SNAPSHOT)
    assert result.of_type("request_screenshot") == [
        {"type": "request_screenshot", "turn_id": "turn-1"}
    ]
    assert result.speech == ["I looked at the screen."]


def test_other_questions_on_a_thin_page_still_use_a_screenshot():
    with session() as client:
        result = client.ask("where am I?", snapshot=STATS_SNAPSHOT)
    assert "request_screenshot" in result.types
