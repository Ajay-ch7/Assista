"""Local commands: stop, repeat, slower, faster, spell it, how much detail to give, and
reading back the action log.

The extension carries them out. When one arrives as speech, the backend sends
transcript_final, so the extension hears it, and ends the turn without answering.
Mirrors extension/src/shared/localCommands.ts; tests/test_local_commands.py checks both
against extension/src/shared/localCommands.json.
"""

from __future__ import annotations

import re

PHRASES: dict[str, tuple[str, ...]] = {
    "stop": ("stop", "stop talking", "stop speaking", "be quiet", "quiet", "silence", "shush"),
    "repeat": (
        "repeat",
        "repeat that",
        "repeat it",
        "say that again",
        "say it again",
        "again",
        "pardon",
        "come again",
        "what did you say",
        "one more time",
    ),
    "slower": (
        "slower",
        "speak slower",
        "talk slower",
        "slow down",
        "more slowly",
        "speak more slowly",
        "too fast",
    ),
    "faster": (
        "faster",
        "speak faster",
        "talk faster",
        "speed up",
        "more quickly",
        "speak more quickly",
        "too slow",
    ),
    "brief": (
        "be brief",
        "brief",
        "brief mode",
        "brief answers",
        "shorter",
        "shorter answers",
        "less detail",
        "keep it short",
    ),
    "normal": (
        "normal detail",
        "normal answers",
        "normal mode",
        "normal verbosity",
        "medium detail",
    ),
    "detailed": (
        "detailed",
        "be detailed",
        "detailed mode",
        "detailed answers",
        "more detail",
        "more details",
        "longer answers",
    ),
    "spell": ("spell it", "spell that", "spell that again", "spell it out", "spell"),
    "actions": (
        "what did you do",
        "what did you just do",
        "what have you done",
        "what have you done so far",
        "what did you do so far",
        "what actions did you take",
        "read the action log",
        "action log",
    ),
    "forget": (
        "forget my details",
        "forget my saved details",
        "forget saved details",
        "clear my details",
        "clear my saved details",
        "delete my details",
        "delete my saved details",
        "forget what you saved",
    ),
    "private_on": (
        "private mode",
        "private mode on",
        "turn on private mode",
        "turn private mode on",
        "switch on private mode",
        "start private mode",
        "go private",
    ),
    "private_off": (
        "private mode off",
        "turn off private mode",
        "turn private mode off",
        "switch off private mode",
        "stop private mode",
        "leave private mode",
    ),
}
_ALL = {phrase for phrases in PHRASES.values() for phrase in phrases}

_LEADING = re.compile(
    r"^(?:(?:hey|ok|okay)\s+)?(?:assista\s+)?(?:please\s+)?(?:can you\s+|could you\s+)?"
)
_TRAILING = re.compile(r"(?:\s+(?:please|now|assista|thanks|thank you))+$")


def normalize(text: str) -> str:
    """Lowercases, drops punctuation and filler words, as the extension does."""
    said = re.sub(r"[^a-z0-9@.\s'-]+", " ", text.lower())
    said = re.sub(r"[.]+(\s|$)", " ", said)
    said = re.sub(r"\s+", " ", said).strip()
    return _TRAILING.sub("", _LEADING.sub("", said, count=1)).strip()


def is_local_command(text: str) -> bool:
    said = normalize(text)
    return said in _ALL or said.startswith("spell ")
