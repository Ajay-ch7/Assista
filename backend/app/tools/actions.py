"""Tool schemas for the Actor (implementation.md section 5.4)."""

from __future__ import annotations

from app.llm.base import ToolSpec

_REF = {
    "type": "string",
    "description": "The element's ref from the latest page data, such as e12.",
}


def _tool(name: str, description: str, properties: dict, required: list[str]) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=description,
        parameters={"type": "object", "properties": properties, "required": required},
    )


CLICK = _tool(
    "click",
    "Press a button, follow a link, or tick or untick a checkbox or radio button.",
    {"ref": _REF},
    ["ref"],
)
TYPE = _tool(
    "type",
    "Put text into a text field, replacing what is there. On a sensitive field this types "
    "nothing: it moves focus there so the user can type the value themselves.",
    {
        "ref": _REF,
        "text": {"type": "string", "description": "The text to put in the field."},
        "use_saved": {
            "type": "boolean",
            "description": (
                "Fill the field with the user's saved detail instead of `text`. Only for a "
                "field whose state has saved true, and only after the user agreed."
            ),
        },
    },
    ["ref"],
)
SELECT = _tool(
    "select",
    "Choose an option in a drop-down list.",
    {"ref": _REF, "option": {"type": "string", "description": "The option's text."}},
    ["ref", "option"],
)
FOCUS = _tool(
    "focus",
    "Move keyboard focus to an element, such as a search box or a heading, without typing "
    "or pressing anything, so that the user can type there or carry on from there.",
    {"ref": _REF},
    ["ref"],
)
SCROLL = _tool(
    "scroll",
    "Scroll the page, or scroll one element into view when ref is given.",
    {
        "direction": {"type": "string", "enum": ["down", "up", "top", "bottom"]},
        "ref": _REF,
    },
    [],
)
GO_BACK = _tool("go_back", "Go back to the previous page.", {}, [])
SWITCH_TAB = _tool(
    "switch_tab",
    "Switch to another open browser tab, by part of its title or by its position.",
    {
        "query": {"type": "string", "description": "Part of the tab's title or address."},
        "index": {"type": "integer", "description": "Position of the tab; 1 is the first."},
    },
    [],
)
OPEN_URL = _tool(
    "open_url",
    "Open a web address in the current tab, or in a new tab.",
    {
        "url": {"type": "string", "description": "The address, such as example.com."},
        "new_tab": {"type": "boolean"},
    },
    ["url"],
)
WEB_SEARCH = _tool(
    "web_search",
    "Search the web with a search engine and open its results page, in the current tab or "
    "in a new tab. Use it to find a website, not to search the page or site the user is on.",
    {
        "query": {"type": "string", "description": "The words to search for."},
        "new_tab": {"type": "boolean"},
    },
    ["query"],
)
ASK_USER = _tool(
    "ask_user",
    "Ask the user one short question and wait for their answer, for example the value for "
    "the next form field. Ends your turn.",
    {"question": {"type": "string"}},
    ["question"],
)

PAGE_ACTIONS = [CLICK, TYPE, SELECT, FOCUS, SCROLL, GO_BACK, SWITCH_TAB, OPEN_URL, WEB_SEARCH]
"""Tools the extension carries out."""
ACTOR_TOOLS = [*PAGE_ACTIONS, ASK_USER]
