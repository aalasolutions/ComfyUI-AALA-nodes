from __future__ import annotations

from typing import Any


def crop_to_pixels(crop: dict[str, Any] | None, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Normalized {x, y, w, h} of a width x height frame to a pixel box; None means full frame."""
    if not crop:
        return None
    x = min(max(round(crop["x"] * width), 0), width - 1)
    y = min(max(round(crop["y"] * height), 0), height - 1)
    w = min(max(round(crop["w"] * width), 1), width - x)
    h = min(max(round(crop["h"] * height), 1), height - y)
    if (x, y, w, h) == (0, 0, width, height):
        return None
    return x, y, w, h
