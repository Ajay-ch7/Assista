"""Splits a streamed reply into sentences, so each can be spoken as soon as it is complete."""

from __future__ import annotations

import re

# A sentence ends at ., ! or ? (plus any closing quote or bracket) followed by whitespace,
# or at a line break. "3.5" and "example.com" have no whitespace after the dot.
_BOUNDARY = re.compile(r"""([.!?]+["')\]]*)\s+|\n+""")
_ABBREVIATION = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$")


class SentenceSplitter:
    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> list[str]:
        """Adds streamed text and returns the sentences it completed."""
        self._buffer += text
        sentences: list[str] = []
        search_from = 0
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
        return sentences

    def flush(self) -> list[str]:
        """Returns whatever is left once the stream has ended."""
        rest = self._buffer.strip()
        self._buffer = ""
        return [rest] if rest else []
