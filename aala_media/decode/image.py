from __future__ import annotations

from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.model_management
import node_helpers

from .crop import crop_to_pixels

_ROTATE_CLOCKWISE = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}
_SIXTEEN_BIT_MODES = {"I;16", "I;16B", "I;16L", "I;16N"}


def load_image(path: str, edit: dict[str, Any]) -> torch.Tensor:
    """First frame, EXIF transpose, rotate, mirror, crop, RGB; returns [1, H, W, 3] in 0..1."""
    with node_helpers.pillow(Image.open, path) as source:
        source.seek(0)
        image = node_helpers.pillow(ImageOps.exif_transpose, source)

    rotate = edit.get("rotate", 0)
    if rotate:
        image = image.transpose(_ROTATE_CLOCKWISE[rotate])
    if edit.get("mirror"):
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    box = crop_to_pixels(edit.get("crop"), image.width, image.height)
    if box is not None:
        x, y, w, h = box
        image = image.crop((x, y, x + w, y + h))

    tensor = torch.from_numpy(_to_rgb_float(image))[None,]
    return tensor.to(device=comfy.model_management.intermediate_device(), dtype=comfy.model_management.intermediate_dtype())


def _to_rgb_float(image: Image.Image) -> np.ndarray:
    """RGB float32 in 0..1; alpha is dropped. 16-bit gray scales by 65535, 32-bit "I" by the range it uses, float gray as 0..1."""
    if image.mode in _SIXTEEN_BIT_MODES:
        gray = np.asarray(image).astype(np.float32) / 65535.0
    elif image.mode == "I":
        values = np.asarray(image).astype(np.float64)
        peak = values.max(initial=0)
        scale = 255.0 if peak <= 255 else 65535.0 if peak <= 65535 else 4294967295.0
        gray = (values / scale).astype(np.float32)
    elif image.mode == "F":
        gray = np.asarray(image, dtype=np.float32)
    else:
        return np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    gray = np.clip(np.nan_to_num(gray), 0.0, 1.0)
    return np.ascontiguousarray(np.repeat(gray[..., None], 3, axis=2))
