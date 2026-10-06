"""Tool schemas for the Watcher (implementation.md section 5.4)."""

from __future__ import annotations

from app.llm.base import ToolSpec

SET_WATCH = ToolSpec(
    name="set_watch",
    description=(
        "Start watching one element of the page and tell the user later when its text "
        "meets a condition."
    ),
    parameters={
        "type": "object",
        "properties": {
            "ref": {
                "type": "string",
                "description": (
                    "The ref, from the page data, of the smallest element whose text holds "
                    "the value to watch, such as the paragraph with the price."
                ),
            },
            "condition": {
                "type": "string",
                "enum": ["changes", "decreases", "increases", "below", "above", "contains"],
                "description": (
                    "changes: any change. decreases or increases: the number in the text "
                    "goes down or up. below or above: the number passes `value`. contains: "
                    "the text starts to include the words in `value`."
                ),
            },
            "value": {
                "type": "string",
                "description": "The number for below or above, or the words for contains.",
            },
            "label": {
                "type": "string",
                "description": "A short name the user would use, such as 'the price'.",
            },
            "alert": {
                "type": "string",
                "description": (
                    "The sentence to speak when the watch fires. Write {value} where the "
                    "new text goes and {old} where the previous text goes."
                ),
            },
        },
        "required": ["ref", "condition", "label", "alert"],
    },
)
LIST_WATCHES = ToolSpec(
    name="list_watches",
    description="List everything being watched for the user.",
    parameters={"type": "object", "properties": {}},
)
CANCEL_WATCH = ToolSpec(
    name="cancel_watch",
    description="Stop watching. Without a query, every watch is cancelled.",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Words from the watch's label or page, such as 'price'.",
            }
        },
    },
)

WATCHER_TOOLS = [SET_WATCH, LIST_WATCHES, CANCEL_WATCH]
