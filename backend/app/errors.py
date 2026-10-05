"""Errors that end a turn with a sentence the user hears."""

from __future__ import annotations


class TurnError(Exception):
    """Ends the turn with a sentence the user will hear."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
