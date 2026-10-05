"""Vision: image description with follow-ups (F04), and the fallback for thin pages."""

from app.config import Settings
from app.llm.base import ImagePart, StreamEnd, TextDelta, ToolCall, ToolCallRequest
from app.llm.mock import MockLLM
from app.main import Deps, model_responder
from tests.harness import NO_REPLY, SCREENSHOT, SHOP_SNAPSHOT, session

THIN = {**SHOP_SNAPSHOT, "flags": {**SHOP_SNAPSHOT["flags"], "thin": True}}


def session_with(llm: MockLLM, **deps):
    config = Settings()
    return session(Deps(settings=config, respond=model_responder(config, llm), **deps))


def images_in(request) -> list[ImagePart]:
    return [
        part
        for message in request.messages
        if not isinstance(message.content, str)
        for part in message.content
        if isinstance(part, ImagePart)
    ]


def test_an_image_is_cropped_and_described():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("describe the product photo")
    (request,) = result.of_type("request_screenshot")
    assert request["ref"] == "i1"
    assert result.speech == ["I looked at a picture: A green backpack."]
    assert result.types[-1] == "done"

    looked, answered = llm.specialist_requests
    assert [tool.name for tool in looked.tools] == ["capture_screenshot", "crop_element"]
    tool_message = answered.messages[-1]
    assert tool_message.role == "tool"
    assert images_in(answered) == [ImagePart(SCREENSHOT["image"], "image/jpeg")]
    # Images and page content never go into the system prompt.
    assert SCREENSHOT["image"] not in answered.system


def test_a_follow_up_is_answered_without_asking_for_the_image_again():
    """The Phase 2 exit check for images."""
    llm = MockLLM()
    with session_with(llm) as client:
        client.ask("describe the product photo")
        follow_up = client.ask("is it waterproof?")
    assert "request_screenshot" not in follow_up.types
    assert follow_up.speech == ["Looking again at the picture I described: A green backpack."]
    request = llm.specialist_requests[-1]
    assert images_in(request) == [ImagePart(SCREENSHOT["image"], "image/jpeg")]
    assert "Pictures you looked at earlier, attached in this order: i1." in str(
        request.messages[-1].content[0]
    )


def test_a_picture_already_taken_is_not_captured_again_even_if_the_model_asks():
    again = ToolCall(id="c2", name="crop_element", arguments={"ref": "i1"})
    llm = MockLLM(
        script=[
            [ToolCallRequest(ToolCall(id="c1", name="crop_element", arguments={"ref": "i1"}))],
            [TextDelta("CONFIDENCE: high\nA green backpack."), StreamEnd()],
            [ToolCallRequest(again), StreamEnd("tool_use")],
            [TextDelta("CONFIDENCE: high\nYes, it has a rain cover."), StreamEnd()],
        ]
    )
    with session_with(llm) as client:
        first = client.ask("describe the product photo")
        second = client.ask("what colour is it?")
    assert len(first.of_type("request_screenshot")) == 1
    assert "request_screenshot" not in second.types
    assert second.speech == ["Yes, it has a rain cover."]


def test_a_new_page_means_new_pictures():
    llm = MockLLM()
    other_page = {**SHOP_SNAPSHOT, "url": "http://127.0.0.1:8787/other.html"}
    with session_with(llm) as client:
        client.ask("describe the product photo")
        result = client.ask("describe the photo", snapshot=other_page)
    assert len(result.of_type("request_screenshot")) == 1


def test_the_screen_is_captured_for_charts_and_layout():
    with session_with(MockLLM()) as client:
        result = client.ask("what is on the screen?")
    (request,) = result.of_type("request_screenshot")
    assert "ref" not in request
    assert result.speech == ["I looked at the screen."]


def test_a_failed_capture_is_explained():
    failed = {"image": None, "error": "tab_not_visible"}
    with session_with(MockLLM()) as client:
        result = client.ask("describe the photo", screenshot=failed)
    assert result.speech == [
        "I can only look at the tab that is on screen.",
        "Switch to it and ask again.",
    ]
    assert result.types[-1] == "done"


def test_a_capture_that_never_arrives_is_explained():
    with session_with(MockLLM(), screenshot_timeout=0.05) as client:
        result = client.ask("describe the photo", screenshot=NO_REPLY)
    assert result.speech == ["The page did not send me a picture in time."]


def test_private_mode_sends_no_pictures():
    llm = MockLLM()
    with session_with(llm) as client:
        client.send(
            {"type": "settings", "turn_id": "s", "verbosity": "normal", "private_mode": True}
        )
        photo = client.ask("describe the photo")
        thin = client.ask("where am I?", snapshot=THIN)
    for result in (photo, thin):
        assert "request_screenshot" not in result.types
    assert "Private mode is on" in photo.speech[0]
    assert thin.speech[0].startswith("This page is titled")


def test_the_looking_stops_after_a_few_rounds():
    calls = [
        [ToolCallRequest(ToolCall(id=f"c{i}", name="capture_screenshot", arguments={}))]
        for i in range(2)
    ]
    llm = MockLLM(script=[*calls, [TextDelta("CONFIDENCE: low\nIt is hard to tell."), StreamEnd()]])
    with session_with(llm) as client:
        result = client.ask("what is on the screen?")
    assert len(llm.specialist_requests) == 3
    assert llm.specialist_requests[-1].tools == []
    assert result.speech[-1] == "It is hard to tell."


def test_a_thin_page_is_read_from_a_screenshot_as_well():
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("where am I?", snapshot=THIN)
    (request,) = result.of_type("request_screenshot")
    assert "ref" not in request
    assert result.speech[0] == (
        "From the screenshot: This page is titled Trail Backpack 30L - Riverside Outfitters."
    )
    (vision,) = llm.specialist_requests
    assert images_in(vision) == [ImagePart(SCREENSHOT["image"], "image/jpeg")]
    assert "A screenshot of the screen is attached." in str(vision.messages[-1].content[0])


def test_a_thin_page_without_a_screenshot_is_read_from_the_snapshot():
    failed = {"image": None, "error": "tab_not_visible"}
    llm = MockLLM()
    with session_with(llm) as client:
        result = client.ask("where am I?", snapshot=THIN, screenshot=failed)
    assert result.speech[:2] == ["I'm not sure about this.", "This page is hard to read."]
    (vision,) = llm.specialist_requests
    assert images_in(vision) == []
    assert "No screenshot is attached" in vision.messages[-1].content


def test_a_question_after_a_thin_page_reuses_its_screenshot():
    with session_with(MockLLM()) as client:
        client.ask("where am I?", snapshot=THIN)
        result = client.ask("what colour is the screen?", snapshot=THIN)
    assert "request_screenshot" not in result.types
