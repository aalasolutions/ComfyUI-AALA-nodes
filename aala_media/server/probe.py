from __future__ import annotations

import os
from fractions import Fraction
from typing import Any

import av
from PIL import Image

from ..kinds import detect_kind
from .fs import FsError, file_for_streaming

MISSING_CODES = ("bad_request", "not_found", "not_a_file")


def probe(raw_path: str) -> dict[str, Any]:
    try:
        path = file_for_streaming(raw_path)
    except FsError as error:
        return {"missing": True} if error.code in MISSING_CODES else {"error": error.code}

    try:
        stat = os.stat(path)
        meta: dict[str, Any] = {"size": stat.st_size, "mtime": stat.st_mtime}
        kind = detect_kind(path)
        if kind == "image":
            meta.update(_probe_image(path))
        elif kind in ("video", "audio"):
            meta.update(_probe_av(path, kind))
        return meta
    except PermissionError:
        return {"error": "permission_denied"}
    except Exception as error:  # decoders raise many unrelated types for unreadable media
        return {"error": f"unreadable: {error}"}


def probe_many(paths: list[str]) -> dict[str, dict[str, Any]]:
    return {path: probe(path) for path in dict.fromkeys(paths)}


def _probe_image(path: str) -> dict[str, Any]:
    with Image.open(path) as image:
        width, height = image.size
        if _exif_orientation(image) in (5, 6, 7, 8):
            width, height = height, width
        return {"width": width, "height": height}


def _exif_orientation(image: Image.Image) -> int:
    try:
        return int(image.getexif().get(0x0112, 1))
    except Exception:
        return 1


def _probe_av(path: str, kind: str) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    with av.open(path, mode="r") as container:
        duration = float(container.duration / av.time_base) if container.duration else None
        video = next((stream for stream in container.streams if stream.type == "video"), None)
        audio = next((stream for stream in container.streams if stream.type == "audio"), None)

        if kind == "video":
            if video is None:
                raise ValueError("no video stream")
            if duration is None and video.duration and video.time_base:
                duration = float(video.duration * video.time_base)
            rate = _frame_rate(video, duration)
            meta.update(
                {
                    "width": video.codec_context.width,
                    "height": video.codec_context.height,
                    "fps": f"{rate.numerator}/{rate.denominator}",
                    "frames": video.frames or (round(duration * rate) if duration else None),
                    "has_audio": audio is not None,
                }
            )
        elif audio is None:
            raise ValueError("no audio stream")

        if audio is not None:
            meta["sample_rate"] = audio.codec_context.sample_rate
            meta["channels"] = audio.codec_context.channels
        if kind == "audio" and duration is None and audio.duration and audio.time_base:
            duration = float(audio.duration * audio.time_base)

        meta["duration"] = duration
    return meta


def _frame_rate(stream: Any, duration: float | None) -> Fraction:
    if stream.average_rate:
        return Fraction(stream.average_rate)
    if stream.frames and duration:
        return Fraction(stream.frames / duration).limit_denominator()
    return Fraction(1)
