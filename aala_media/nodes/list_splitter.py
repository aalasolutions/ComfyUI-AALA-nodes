from __future__ import annotations

import logging
from typing import Any

from comfy_api.latest import io

MAX_SLOTS = 100
DEFAULT_SLOTS = 3


class ListSplitter(io.ComfyNode):
    """Turns a list into one output socket per item; empty slots output None."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        template = io.MatchType.Template("items")
        return io.Schema(
            node_id="AalaListSplitter",
            display_name="List Splitter",
            category="AALA Nodes/utils",
            description="Splits a list into one output per item. Linked to a Media Manager output, the slot count follows that group's Max.",
            is_input_list=True,
            inputs=[
                io.MatchType.Input("items", template=template),
                io.Int.Input("slots", default=DEFAULT_SLOTS, min=1, max=MAX_SLOTS, step=1),
            ],
            outputs=[io.MatchType.Output(template, id=f"item_{index + 1}", display_name=str(index)) for index in range(MAX_SLOTS)],
        )

    @classmethod
    def execute(cls, items: list[Any] | None = None, slots: list[int] | None = None) -> io.NodeOutput:
        values = list(items or [])
        count = max(1, min(int(slots[0]) if slots else DEFAULT_SLOTS, MAX_SLOTS))
        if len(values) > count:
            logging.warning("[List Splitter] %d items for %d slots; items after slot %d are not output", len(values), count, count)
        return io.NodeOutput(*(values[index] if index < min(count, len(values)) else None for index in range(MAX_SLOTS)))
