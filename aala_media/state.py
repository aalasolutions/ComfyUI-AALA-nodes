from __future__ import annotations

import json
import math
from typing import Any

SCHEMA_ID = "aala-media/manager"
SCHEMA_VERSION = 1
KINDS = ("image", "video", "audio")
DEFAULT_LIMIT = 9


class MediaStateError(ValueError):
    pass


def default_state() -> dict[str, Any]:
    return {
        "schema": SCHEMA_ID,
        "version": SCHEMA_VERSION,
        "limits": {kind: DEFAULT_LIMIT for kind in KINDS},
        "groups": {kind: [] for kind in KINDS},
        "ui": {"layout": "list", "collapsed": {kind: False for kind in KINDS}},
    }


def default_state_json() -> str:
    return json.dumps(default_state(), separators=(",", ":"))


def parse_state(raw: Any) -> dict[str, Any]:
    if raw is None:
        return default_state()
    if not isinstance(raw, str):
        raise MediaStateError("Media state must be a JSON string")
    if raw.strip() == "":
        return default_state()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MediaStateError(f"Media state is not valid JSON: {error.msg}") from error

    if not isinstance(data, dict) or data.get("schema") != SCHEMA_ID:
        raise MediaStateError(f"Media state schema must be '{SCHEMA_ID}'")

    version = data.get("version")
    if not isinstance(version, int) or version < 1:
        raise MediaStateError("Media state version is missing or invalid")
    if version > SCHEMA_VERSION:
        raise MediaStateError(
            f"Media state version {version} is newer than supported version {SCHEMA_VERSION}; update ComfyUI-AALA-nodes"
        )

    state = default_state()
    state["ui"] = data.get("ui") if isinstance(data.get("ui"), dict) else state["ui"]

    limits = data.get("limits", {})
    if not isinstance(limits, dict):
        raise MediaStateError("Media state limits must be an object")
    for kind in KINDS:
        value = limits.get(kind, DEFAULT_LIMIT)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise MediaStateError(f"Limit for {kind} must be a non-negative integer")
        state["limits"][kind] = value

    groups = data.get("groups", {})
    if not isinstance(groups, dict):
        raise MediaStateError("Media state groups must be an object")
    for kind in KINDS:
        items = groups.get(kind, [])
        if not isinstance(items, list):
            raise MediaStateError(f"Group {kind} must be a list")
        for item in items:
            if not isinstance(item, dict) or item.get("kind") != kind or not isinstance(item.get("path"), str):
                raise MediaStateError(f"Group {kind} contains an invalid item")
            _validate_item(kind, item)
        active = sum(1 for item in items if item.get("active", False))
        if active > state["limits"][kind]:
            raise MediaStateError(f"limit {state['limits'][kind]} is full")
        state["groups"][kind] = items

    return state


ITEM_FIELDS = {
    "image": {"id", "path", "kind", "active", "meta", "edit"},
    "video": {"id", "path", "kind", "active", "muted", "meta", "edit", "split_of", "part", "parts"},
    "audio": {"id", "path", "kind", "active", "muted", "meta", "edit"},
}
EDIT_FIELDS = {
    "image": {"crop", "rotate", "mirror"},
    "video": {"crop", "rotate", "mirror", "trim"},
    "audio": {"trim"},
}
ROTATIONS = (0, 90, 180, 270)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_item(kind: str, item: dict[str, Any]) -> None:
    label = f"{kind} item {item.get('path')}"
    extra = sorted(set(item) - ITEM_FIELDS[kind])
    if extra:
        raise MediaStateError(f"{label}: field {extra[0]} does not apply to {kind}")
    if "\x00" in item["path"]:
        raise MediaStateError(f"{kind} item path contains a NUL character")
    if "id" in item and not isinstance(item["id"], str):
        raise MediaStateError(f"{label}: id must be a string")
    for flag in ("active", "muted"):
        if flag in item and not isinstance(item[flag], bool):
            raise MediaStateError(f"{label}: {flag} must be true or false")
    if item.get("meta") is not None and not isinstance(item["meta"], dict):
        raise MediaStateError(f"{label}: meta must be an object or null")
    _validate_edit(kind, label, item.get("edit", {}))
    if kind == "video":
        _validate_split(label, item)


def _validate_edit(kind: str, label: str, edit: Any) -> None:
    if not isinstance(edit, dict):
        raise MediaStateError(f"{label}: edit must be an object")
    extra = sorted(set(edit) - EDIT_FIELDS[kind])
    if extra:
        raise MediaStateError(f"{label}: edit {extra[0]} does not apply to {kind}")

    crop = edit.get("crop")
    if crop is not None:
        if not isinstance(crop, dict) or set(crop) != {"x", "y", "w", "h"} or not all(_is_number(v) for v in crop.values()):
            raise MediaStateError(f"{label}: crop must be {{x, y, w, h}} numbers")
        eps = 1e-6
        if crop["x"] < 0 or crop["y"] < 0 or crop["w"] <= 0 or crop["h"] <= 0 or crop["x"] + crop["w"] > 1 + eps or crop["y"] + crop["h"] > 1 + eps:
            raise MediaStateError(f"{label}: crop must lie within 0 to 1")
    if "rotate" in edit and not (_is_int(edit["rotate"]) and edit["rotate"] in ROTATIONS):
        raise MediaStateError(f"{label}: rotate must be one of 0, 90, 180, 270")
    if "mirror" in edit and not isinstance(edit["mirror"], bool):
        raise MediaStateError(f"{label}: mirror must be true or false")

    trim = edit.get("trim")
    if trim is None:
        return
    if kind == "video":
        if not isinstance(trim, dict) or set(trim) != {"start_frame", "end_frame"}:
            raise MediaStateError(f"{label}: trim must be {{start_frame, end_frame}}")
        start, end = trim["start_frame"], trim["end_frame"]
        if not (_is_int(start) and _is_int(end) and 0 <= start < end):
            raise MediaStateError(f"{label}: trim needs integer frames with 0 <= start_frame < end_frame")
    else:
        if not isinstance(trim, dict) or set(trim) != {"start", "end"}:
            raise MediaStateError(f"{label}: trim must be {{start, end}}")
        start, end = trim["start"], trim["end"]
        if not (_is_number(start) and _is_number(end) and 0 <= start < end):
            raise MediaStateError(f"{label}: trim needs seconds with 0 <= start < end")


def _validate_split(label: str, item: dict[str, Any]) -> None:
    split_of, part, parts = item.get("split_of"), item.get("part"), item.get("parts")
    if split_of is None and part is None and parts is None:
        return
    if not isinstance(split_of, str) or not _is_int(part) or not _is_int(parts) or not 1 <= part <= parts:
        raise MediaStateError(f"{label}: split_of, part and parts must be set together with 1 <= part <= parts")
