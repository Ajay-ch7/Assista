import json

import pytest

from app.config import REPO_ROOT
from app.local_commands import PHRASES, is_local_command, normalize
from tests.harness import session
from tests.test_spoken_turn import mock_voice

SHARED = REPO_ROOT / "extension" / "src" / "shared" / "localCommands.json"


def test_the_phrases_match_the_extension():
    shared = json.loads(SHARED.read_text(encoding="utf-8"))
    assert {kind: list(phrases) for kind, phrases in PHRASES.items()} == shared


@pytest.mark.parametrize(
    "text",
    [
        "Stop.",
        "Assista, stop talking",
        "please repeat that",
        "Say that again?",
        "Slower please",
        "More detail, please.",
        "Spell it.",
        "Spell Kaveri.",
    ],
)
def test_local_commands_are_recognised(text):
    assert is_local_command(text)


@pytest.mark.parametrize(
    "text",
    ["stop the video on this page", "how do you spell relief?", "where am I?", ""],
)
def test_requests_are_not_local_commands(text):
    assert not is_local_command(text)


def test_normalize_drops_filler_and_punctuation():
    assert normalize("  Hey Assista, could you REPEAT that, please?! ") == "repeat that"


def test_a_spoken_local_command_ends_the_turn_without_an_answer():
    with session(**mock_voice()) as client:
        result = client.say(b"Slower, please.")
    assert result.types == ["transcript_final", "done"]
    assert result.of_type("transcript_final")[0]["text"] == "Slower, please."
