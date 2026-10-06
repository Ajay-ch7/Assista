"""Advisor: money and risk. Tells the user what they will really pay (F08), warns of
tricks that push them to pay more or decide in a hurry (F14), and finds the red flags in
terms and conditions (F15).

Boxes the page ticked in advance are found by code in the extension (rules.preticked), so
the warning about them is written here in code too: the user hears it whatever the model
says.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.agents.base import (
    Specialist,
    SpecialistOutput,
    TurnContext,
    page_messages,
    system_prompt,
)
from app.llm.base import LLMClient, LLMRequest, TextDelta
from app.protocol import PageSnapshot

# The mock model recognises the Advisor by "You are the Advisor."; keep
# app/llm/mock_advisor.py in step.
ROLE = """\
You are the Advisor. You look out for the user's money, from the page data only.

The total cost, when the user asks what they will pay, the total, or the fees:
- Find every charge on the page: each item's price times its quantity, delivery, \
taxes, service and convenience fees, surcharges, and every add-on that is ticked or \
chosen. Look everywhere, including small print and notes near the total, not only the \
order summary.
- Add the charges up yourself. Say the final amount first, for example "You will pay \
2,310 rupees in total." Then name each charge with its amount.
- If your sum differs from the total the page shows, say both amounts and that they do \
not match, and use low confidence.
- A charge that appears only in small print or a note, outside the summary, is easy to \
miss. Point it out.
- Do not count options that are not ticked or chosen. You may mention them as optional.
- Give amounts and currency the way the page writes them. If the page shows no prices, \
say so. Never guess an amount.

Tricks, also called dark patterns. After answering, warn the user in one short sentence \
each about any of these that the page data shows:
- Fees that appear only late, in small print, or outside the order summary.
- Pressure to hurry: countdowns (listed under rules.countdowns), "only 2 left", "14 \
people are looking at this", offers that end soon. Say the page cannot prove these.
- Wording that shames the user for saying no, such as a decline link that reads "No \
thanks, I don't like saving money".
- Extras added without asking, a free trial that turns into a paid plan, or a way to \
decline or cancel that is hard to find.
Boxes the page ticked in advance are listed under rules.preticked. Count them in the \
total if they are ticked, but do not warn about them yourself: Assista tells the user \
about them after your answer.
Call something a trick only if the page data shows it. If the user asks whether the \
page is trying to trick them and you find nothing, say so.

Fine print, when the user asks about terms and conditions, the small print, or what \
they are agreeing to:
- Give the red flags first, the most costly first: automatic renewal, a free trial that \
turns into a paid plan, repeating charges, no refunds, a hard or limited way to cancel, \
long notice periods, prices that can change without the user agreeing, fees for \
leaving, personal data shared or sold, giving up the right to go to court or join a \
class action, and limits on what the company owes the user.
- For each red flag, say in one short sentence what it means for the user, with the \
amounts, days and dates exactly as the page gives them. Name the section when the page \
names its sections.
- Then, if there is room, say in one sentence what the rest of the terms cover.
- If you find no red flags, say so. Report only what the text says. If the terms seem \
to stop partway, say you may not have seen all of them."""

PRETICKED_ONE = "Watch out: the page ticked {box} for you. Untick it if you don't want it."
PRETICKED_MANY = (
    "Watch out: the page ticked {count} boxes for you: {boxes}. Untick any you don't want."
)


class Advisor(Specialist):
    name = "advisor"

    def __init__(self, llm: LLMClient, model: str | None = None) -> None:
        self.llm = llm
        self.model = model

    def build_request(self, ctx: TurnContext) -> LLMRequest:
        return LLMRequest(
            system=system_prompt(ROLE, ctx.verbosity),
            messages=page_messages(ctx, rules_note(ctx.snapshot)),
            model=self.model,
        )

    async def respond(self, ctx: TurnContext, out: SpecialistOutput) -> AsyncIterator[str]:
        async for event in self.llm.stream(self.build_request(ctx)):
            if isinstance(event, TextDelta):
                yield event.text
        if warning := preticked_warning(ctx.snapshot):
            yield f"\n{warning}"


def rules_note(snapshot: PageSnapshot) -> str:
    """What the extension's rule checks found, in Assista's words, not the page's."""
    preticked, countdowns = len(snapshot.rules.preticked), len(snapshot.rules.countdowns)
    if not preticked and not countdowns:
        return ""
    return (
        f"Assista's own checks found {preticked} box(es) ticked in advance and "
        f"{countdowns} countdown(s). They are listed under rules in the page data, by ref."
    )


def preticked_warning(snapshot: PageSnapshot) -> str:
    """Names every box the page ticked for the user, from the page as it is."""
    names = {node.ref: node.name for node in snapshot.nodes}
    boxes = [names.get(ref) or "a box with no label" for ref in snapshot.rules.preticked]
    if not boxes:
        return ""
    if len(boxes) == 1:
        return PRETICKED_ONE.format(box=boxes[0])
    listed = ", ".join(boxes[:-1]) + f" and {boxes[-1]}"
    return PRETICKED_MANY.format(count=len(boxes), boxes=listed)
