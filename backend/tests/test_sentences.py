from app.voice.sentences import SentenceSplitter


def split(*pieces: str) -> list[str]:
    splitter = SentenceSplitter()
    out: list[str] = []
    for piece in pieces:
        out += splitter.feed(piece)
    return out + splitter.flush()


def test_splits_on_sentence_ends():
    assert split("Hello there. How are you? Fine!") == ["Hello there.", "How are you?", "Fine!"]


def test_waits_for_the_rest_of_a_sentence():
    splitter = SentenceSplitter()
    assert splitter.feed("This is a shop") == []
    assert splitter.feed(". It sells") == ["This is a shop."]
    assert splitter.flush() == ["It sells"]


def test_does_not_split_until_whitespace_follows():
    # The next piece could continue a number: "3." then "5".
    splitter = SentenceSplitter()
    assert splitter.feed("It costs 3.") == []
    assert splitter.feed("5 dollars. ") == ["It costs 3.5 dollars."]


def test_keeps_numbers_addresses_and_abbreviations_together():
    assert split("It costs 4,499.50 rupees at example.com today. ") == [
        "It costs 4,499.50 rupees at example.com today."
    ]
    assert split("Ask Dr. Rao about it. ") == ["Ask Dr. Rao about it."]


def test_keeps_closing_quotes_with_their_sentence():
    assert split('She said "stop." Then left.') == ['She said "stop."', "Then left."]


def test_line_breaks_end_sentences():
    assert split("First line\nSecond line") == ["First line", "Second line"]


def test_empty_input_gives_nothing():
    assert split("", "   ", "\n") == []


def test_early_start_cuts_a_long_opening_sentence_at_a_clause():
    splitter = SentenceSplitter(early_start=True)
    first = splitter.feed("The page shows a green backpack for hiking and travel, priced at ")
    assert first == ["The page shows a green backpack for hiking and travel,"]
    rest = splitter.feed("4,499 rupees, and it is in stock. Shall I go on?") + splitter.flush()
    assert rest == ["priced at 4,499 rupees, and it is in stock.", "Shall I go on?"]


def test_early_start_leaves_short_openings_and_numbers_alone():
    splitter = SentenceSplitter(early_start=True)
    assert splitter.feed("Yes, it is in stock at 4,499 rupees, as the page ") == []
    assert splitter.feed("says. Next.") + splitter.flush() == [
        "Yes, it is in stock at 4,499 rupees, as the page says.",
        "Next.",
    ]


def test_early_start_applies_to_the_first_sentence_only():
    splitter = SentenceSplitter(early_start=True)
    out = splitter.feed("Done. ")
    out += splitter.feed("The second sentence is long enough to be cut somewhere, but it is ")
    out += splitter.feed("not the first. ")
    assert out == [
        "Done.",
        "The second sentence is long enough to be cut somewhere, but it is not the first.",
    ]
