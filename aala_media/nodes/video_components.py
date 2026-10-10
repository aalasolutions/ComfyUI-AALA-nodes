from __future__ import annotations

from comfy_api.latest import Input, io
from comfy_execution.graph_utils import ExecutionBlocker

PASS_NONE = "pass None"
SKIP = "skip downstream"


class GetVideoComponents(io.ComfyNode):
    """Core Get Video Components that does not fail on an empty input."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AalaGetVideoComponents",
            display_name="AALA Get Video Components",
            category="AALA Nodes/media",
            search_aliases=["extract frames", "split video", "video to images"],
            description="Extracts frames, audio, frame rate, bit depth and color space. An empty input (for example an unused List Splitter slot) does not fail: it passes None, or silently skips the nodes that use the outputs.",
            inputs=[
                io.Video.Input("video", optional=True, tooltip="The video to extract components from. May be empty."),
                io.Combo.Input(
                    "if_empty",
                    options=[PASS_NONE, SKIP],
                    default=PASS_NONE,
                    tooltip="pass None: for optional inputs such as model reference slots. skip downstream: nodes using these outputs (Preview, Save) are skipped without an error.",
                ),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Audio.Output(display_name="audio"),
                io.Float.Output(display_name="fps"),
                io.Combo.Output(display_name="bit_depth"),
                io.Combo.Output(display_name="color_space"),
            ],
        )

    @classmethod
    def execute(cls, video: Input.Video | None = None, if_empty: str = PASS_NONE) -> io.NodeOutput:
        if video is None:
            empty = ExecutionBlocker(None) if if_empty == SKIP else None
            return io.NodeOutput(*(empty,) * 5)
        components = video.get_components()
        return io.NodeOutput(
            components.images,
            components.audio,
            float(components.frame_rate),
            video.get_bit_depth(),
            video.get_color_space(),
        )
