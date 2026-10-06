"""The user's yes or no to an action the confirmation gate is holding.

The extension decides whether the held action runs; the backend only needs to know that
the words were an answer, so it waits for the extension's `confirm` message instead of
treating them as a new request. Mirrors extension/src/shared/confirmation.ts;
tests/test_confirmation.py checks both against extension/src/shared/confirmation.json.
"""

from __future__ import annotations

from app.local_commands import normalize

WORDS: dict[str, tuple[str, ...]] = {
    "yes": (
        "yes",
        "yeah",
        "yep",
        "yup",
        "yes go ahead",
        "go ahead",
        "yes do it",
        "do it",
        "confirm",
        "i confirm",
        "yes confirm",
        "ok",
        "okay",
        "sure",
        "proceed",
        "yes proceed",
        "go on",
        "correct",
        "that's right",
        "that's correct",
        "yes that's right",
        "yes that's correct",
    ),
    "no": (
        "no",
        "nope",
        "nah",
        "cancel",
        "cancel that",
        "cancel it",
        "no cancel",
        "don't",
        "do not",
        "no don't",
        "don't do it",
        "do not do it",
        "never mind",
        "nevermind",
        "wait",
        "hold on",
        "not yet",
        "abort",
    ),
}


def parse_confirmation(text: str) -> bool | None:
    """True for a clear yes, False for a clear no, None for anything else."""
    said = normalize(text)
    if said in WORDS["yes"]:
        return True
    if said in WORDS["no"]:
        return False
    return None
