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
