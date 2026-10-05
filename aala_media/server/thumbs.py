from __future__ import annotations

import hashlib
import itertools
import json
import os
import tempfile
import threading
import time
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

import av
import numpy as np
from PIL import Image, ImageOps

from ..kinds import detect_kind
from .fs import FsError, file_for_streaming

THUMB_SIZES = (128, 256, 512)
DEFAULT_BUCKETS = 1024
MAX_BUCKETS = 4096
MAX_FRAME_SIZE = 2048
MAX_SECONDS = 10_000_000
CACHE_BUDGET_BYTES = 2 * 1024**3
EVICT_GRACE_SECONDS = 120
PARTIAL_PREFIX = ".partial-"
WEBP_QUALITY = 80
MAX_FRAMES_AFTER_SEEK = 600
MAX_FALLBACK_FRAMES = 20_000
PEAK_BLOCK = 256
CACHE_VERSION = 2


class MediaCache:
    def __init__(self, root: str | os.PathLike[str], budget_bytes: int = CACHE_BUDGET_BYTES):
        self.root = Path(root)
        self.budget_bytes = budget_bytes
        self._lock = threading.Lock()
        self._approx_bytes: int | None = None

    def thumb(self, raw_path: str | None, size: int) -> Path:
        path = file_for_streaming(raw_path)
        kind = detect_kind(path)
        if kind not in ("image", "video"):
            raise FsError("bad_request", "Thumbnails are available for images and videos only", 400)
        size = min(THUMB_SIZES, key=lambda option: abs(option - size))
        render = _render_image if kind == "image" else _render_video_poster
        return self._cached(path, "thumbs", f"thumb-{size}", ".webp", lambda target: render(path, size, target))

    def frame(self, raw_path: str | None, seconds: float, size: int) -> Path:
        path = file_for_streaming(raw_path)
        if detect_kind(path) != "video":
            raise FsError("bad_request", "Frames are available for videos only", 400)
        if not 0 <= seconds <= MAX_SECONDS:
            raise FsError("bad_request", "t must be between 0 and 10000000 seconds", 400)
        size = max(16, min(size, MAX_FRAME_SIZE))
        return self._cached(
            path, "frames", f"frame-{seconds:.4f}-{size}", ".webp", lambda target: _render_frame(path, seconds, size, target)
        )

    def peaks(self, raw_path: str | None, buckets: int) -> dict[str, Any]:
        path = file_for_streaming(raw_path)
        if detect_kind(path) not in ("audio", "video"):
            raise FsError("bad_request", "Peaks are available for audio and video only", 400)
        buckets = max(16, min(buckets, MAX_BUCKETS))
        for _ in range(2):
            cached = self._cached(path, "peaks", f"peaks-{buckets}", ".json", lambda target: _render_peaks(path, buckets, target))
            try:
                return json.loads(cached.read_text())
            except FileNotFoundError:
                continue
        raise FsError("io_error", "Peaks cache entry disappeared while reading", 500)

    def evict(self) -> int:
        with self._lock:
            files = []
            total = 0
            for folder in ("thumbs", "frames", "peaks"):
                for entry in (self.root / folder).glob("*"):
                    if entry.name.startswith(PARTIAL_PREFIX):
                        continue
                    try:
                        stat = entry.stat()
                    except OSError:
                        continue
                    files.append((stat.st_mtime, stat.st_size, entry))
                    total += stat.st_size
            removed = 0
            if total > self.budget_bytes:
                target = int(self.budget_bytes * 0.9)
                cutoff = time.time() - EVICT_GRACE_SECONDS
                for _, size, entry in sorted(files):
                    if total <= target:
                        break
                    try:
                        if entry.stat().st_mtime > cutoff:
                            continue
                        entry.unlink()
                    except OSError:
                        continue
                    total -= size
                    removed += 1
            self._approx_bytes = total
            return removed

    def _cached(self, path: str, folder: str, variant: str, suffix: str, render: Callable[[Path], None]) -> Path:
        stat = os.stat(path)
        key = hashlib.sha1(f"v{CACHE_VERSION}|{path}|{stat.st_size}|{stat.st_mtime_ns}|{variant}".encode()).hexdigest()
        target = self.root / folder / f"{key}{suffix}"
        try:
            os.utime(target)
            return target
        except FileNotFoundError:
            pass

        target.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(dir=target.parent, prefix=PARTIAL_PREFIX, suffix=suffix)
        os.close(handle)
        temp = Path(temp_name)
        try:
            render(temp)
            os.replace(temp, target)
        except FsError:
            raise
        except Exception as error:  # decoders raise many unrelated types for unreadable media
            raise FsError("unreadable", f"Could not decode {os.path.basename(path)}: {error}", 422) from error
        finally:
            temp.unlink(missing_ok=True)
        self._account(target)
        return target

    def _account(self, written: Path) -> None:
        if self._approx_bytes is None:
            self.evict()
            return
        try:
            size = written.stat().st_size
        except FileNotFoundError:
            return
        with self._lock:
            self._approx_bytes += size
            over = self._approx_bytes > self.budget_bytes
        if over:
            self.evict()


def _save_webp(image: Image.Image, size: int, target: Path) -> None:
    image = image.convert("RGB")
    image.thumbnail((size, size))
    image.save(target, "WEBP", quality=WEBP_QUALITY)


def _render_image(path: str, size: int, target: Path) -> None:
    with Image.open(path) as image:
        image.seek(0)
        _save_webp(ImageOps.exif_transpose(image), size, target)


def _render_video_poster(path: str, size: int, target: Path) -> None:
    with av.open(path, mode="r") as container:
        duration = _duration(container, next((item for item in container.streams if item.type == "video"), None))
    seconds = duration * 0.1 if duration >= 10 else min(1.0, duration / 2)
    _render_frame(path, seconds, size, target)


def _render_frame(path: str, seconds: float, size: int, target: Path) -> None:
    with av.open(path, mode="r") as container:
        stream = next((item for item in container.streams if item.type == "video"), None)
        if stream is None:
            raise ValueError("no video stream")
        duration = _duration(container, stream)
        if duration > 0:
            seconds = min(seconds, duration)
        start = Fraction(stream.start_time) * stream.time_base if stream.start_time is not None and stream.time_base else 0

        chosen = _decode_at(container, stream, seconds, start)
        if chosen is None:
            container.seek(0)
            chosen = _last_frame_before(container, stream, seconds, start)
        if chosen is None:
            raise ValueError("no decodable frame")
        _save_webp(chosen.to_image(), size, target)


def _decode_at(container: Any, stream: Any, seconds: float, start: Fraction | int, seek: bool = True) -> Any:
    if seek and seconds > 0 and stream.time_base:
        container.seek(int((Fraction(seconds) + start) / stream.time_base), stream=stream, backward=True, any_frame=False)
    chosen = None
    for index, frame in enumerate(container.decode(stream)):
        chosen = frame
        if frame.time is None or frame.time - float(start) >= seconds - 1e-6 or index >= MAX_FRAMES_AFTER_SEEK:
            break
    return chosen


def _last_frame_before(container: Any, stream: Any, seconds: float, start: Fraction | int) -> Any:
    chosen = None
    for index, frame in enumerate(container.decode(stream)):
        if chosen is not None and frame.time is not None and frame.time - float(start) > seconds:
            break
        chosen = frame
        if index >= MAX_FALLBACK_FRAMES:
            break
    return chosen


def _duration(container: Any, stream: Any) -> float:
    if container.duration:
        return float(container.duration / av.time_base)
    if stream is not None and stream.duration and stream.time_base:
        return float(stream.duration * stream.time_base)
    return 0.0


def _render_peaks(path: str, buckets: int, target: Path) -> None:
    with av.open(path, mode="r") as container:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise ValueError("no audio stream")
        sample_rate = stream.codec_context.sample_rate
        channels = stream.codec_context.channels
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sample_rate)

        block_mins: list[np.ndarray] = []
        block_maxs: list[np.ndarray] = []
        pending = np.zeros(0, dtype=np.float32)
        total = 0

        def consume(samples: np.ndarray) -> np.ndarray:
            usable = (len(samples) // PEAK_BLOCK) * PEAK_BLOCK
            if usable:
                blocks = samples[:usable].reshape(-1, PEAK_BLOCK)
                block_mins.append(blocks.min(axis=1))
                block_maxs.append(blocks.max(axis=1))
            return samples[usable:]

        for frame in itertools.chain(container.decode(stream), [None]):
            for mono in resampler.resample(frame):
                data = mono.to_ndarray().reshape(-1).astype(np.float32, copy=False)
                total += len(data)
                pending = consume(np.concatenate((pending, data)))
        if len(pending):
            block_mins.append(np.array([pending.min()], dtype=np.float32))
            block_maxs.append(np.array([pending.max()], dtype=np.float32))

    mins = np.concatenate(block_mins) if block_mins else np.zeros(0, dtype=np.float32)
    maxs = np.concatenate(block_maxs) if block_maxs else np.zeros(0, dtype=np.float32)
    groups = min(buckets, len(mins))
    peaks: list[float] = []
    for low, high in zip(np.array_split(mins, groups), np.array_split(maxs, groups)) if groups else ():
        peaks.extend((round(float(low.min()), 4), round(float(high.max()), 4)))

    payload = {"sample_rate": sample_rate, "duration": total / sample_rate if sample_rate else 0.0, "channels": channels, "peaks": peaks}
    target.write_text(json.dumps(payload, separators=(",", ":")))
