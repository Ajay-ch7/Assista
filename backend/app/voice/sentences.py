"""Splits a streamed reply into sentences, so each can be spoken as soon as it is complete."""

from __future__ import annotations

import re

# A sentence ends at ., ! or ? (plus any closing quote or bracket) followed by whitespace,
# or at a line break. "3.5" and "example.com" have no whitespace after the dot.
_BOUNDARY = re.compile(r"""([.!?]+["')\]]*)\s+|\n+""")
_ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$")
# Where a long opening sentence may be cut so that speech starts sooner: after a comma,
# semicolon or colon that is followed by a space. "4,499" has no space after its comma.
_CLAUSE = re.compile(r"[,;:]\s+")
FIRST_CLAUSE_MIN = 45
"""An opening clause shorter than this is not worth speaking on its own."""


class SentenceSplitter:
    def __init__(self, early_start: bool = False) -> None:
        """With `early_start`, the first thing returned may be the opening clause of a long
        first sentence, so a spoken reply begins before that sentence is complete."""
        self._buffer = ""
        self._early_start = early_start

    def feed(self, text: str) -> list[str]:
        """Adds streamed text and returns the sentences it completed."""
        self._buffer += text
        sentences: list[str] = []
        search_from = 0
        if self._early_start and not _BOUNDARY.search(self._buffer):
            for clause in _CLAUSE.finditer(self._buffer):
                if clause.start() >= FIRST_CLAUSE_MIN:
                    sentences.append(self._buffer[: clause.start() + 1].strip())
                    self._buffer = self._buffer[clause.end() :]
                    self._early_start = False
                    break
        while match := _BOUNDARY.search(self._buffer, search_from):
            end = match.end(1) if match.group(1) else match.start()
            candidate = self._buffer[:end]
            if match.group(1) and _ABBREVIATION.search(candidate):
                search_from = match.end()
                continue
            self._buffer = self._buffer[match.end() :]
            search_from = 0
            if candidate.strip():
                sentences.append(candidate.strip())
        if sentences:
            self._early_start = False
        return sentences

    def flush(self) -> list[str]:
        """Returns whatever is left once the stream has ended."""
        rest = self._buffer.strip()
        self._buffer = ""
        return [rest] if rest else []
