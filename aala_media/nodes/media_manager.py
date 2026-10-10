from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

from comfy_api.latest import io

from ..decode.audio import load_audio
from ..decode.image import load_image
from ..decode.video import load_video
from ..state import KINDS, MediaStateError, default_state_json, parse_state


@io.comfytype(io_type="AALA_MEDIA_STATE")
class MediaState(io.ComfyTypeIO):
    Type = str

    class Input(io.WidgetInput):
        Type = str

        def __init__(self, id: str, display_name: str = None, tooltip: str = None):
            super().__init__(id, display_name, tooltip=tooltip, default=default_state_json(), socketless=True)


class MediaManager(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AalaMediaManager",
            display_name="AALA Media Manager",
            category="AALA Nodes/media",
            inputs=[MediaState.Input("media_state")],
            outputs=[
                io.Image.Output("IMAGES", is_output_list=True),
                io.Video.Output("VIDEOS", is_output_list=True),
                io.Audio.Output("AUDIO", is_output_list=True),
            ],
        )

    @classmethod
    def validate_inputs(cls, media_state: str | None = None) -> bool | str:
        try:
            parse_state(media_state)
        except MediaStateError as error:
            return str(error)
        return True

    @classmethod
    def fingerprint_inputs(cls, media_state: str | None = None) -> str:
        try:
            state = parse_state(media_state)
        except MediaStateError:
            return str(media_state)
        entries = []
        for kind in KINDS:
            for item in _active_items(state, kind):
                path = _resolve(item["path"])
                try:
                    stat = os.stat(path)
                    file_key = [stat.st_size, stat.st_mtime_ns, os.access(path, os.R_OK)]
                except (OSError, ValueError):
                    file_key = None
                entries.append([kind, path, file_key, item.get("muted", False), item.get("edit", {})])
        return hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()

    @classmethod
    def execute(cls, media_state: str) -> io.NodeOutput:
        state = parse_state(media_state)
        outputs: dict[str, list[Any]] = {kind: [] for kind in KINDS}
        missing: list[str] = []
        unreadable: list[str] = []
        for kind in KINDS:
            for item in _active_items(state, kind):
                if kind == "audio" and item.get("muted", False):
                    continue
                path = _resolve(item["path"])
                if not os.path.isfile(path):
                    missing.append(item["path"])
                    continue
                try:
                    with open(path, "rb"):
                        pass
                except OSError:
                    unreadable.append(item["path"])
                    continue
                edit = item.get("edit") or {}
                try:
                    if kind == "image":
                        outputs[kind].append(load_image(path, edit))
                    elif kind == "video":
                        outputs[kind].append(load_video(path, edit, item.get("muted", False)))
                    else:
                        outputs[kind].append(load_audio(path, edit))
                except Exception as error:  # decoders raise many unrelated types
                    raise RuntimeError(f"Media Manager could not decode {item['path']}: {error}") from error
        if missing:
            logging.warning("[Media Manager] skipped %d missing file(s): %s", len(missing), ", ".join(missing))
        if unreadable:
            logging.warning("[Media Manager] skipped %d unreadable file(s): %s", len(unreadable), ", ".join(unreadable))
        ui = {"missing": missing, "unreadable": unreadable}
        return io.NodeOutput(outputs["image"], outputs["video"], outputs["audio"], ui=ui)


def _active_items(state: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [item for item in state["groups"][kind] if item.get("active", False)]


def _resolve(path: str) -> str:
    expanded = os.path.expanduser(path)
    return expanded if os.path.isabs(expanded) else ""
