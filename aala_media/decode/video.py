from __future__ import annotations

import dataclasses
import io
import os
import tempfile
from fractions import Fraction
from typing import Any, IO, Optional, Union

import av
import torch

from comfy_api.latest import Input, InputImpl, Types
from comfy_api.latest._input_impl.video_types import filter_hevc_packet, get_open_write_kwargs, isobmff_hevc_filter
from comfy_api.latest._util import normalize_crop_rect

from .crop import crop_to_pixels


@dataclasses.dataclass
class FrameTimeline:
    """Presentation timestamps of the frames core decodes (pts >= 0), read from packets without decoding."""

    time_base: Fraction
    pts: list[int]
    end: int


def frame_timeline(path: str) -> FrameTimeline:
    with av.open(path, mode="r") as container:
        stream = container.streams.video[0]
        pts: list[int] = []
        end = 0
        for packet in container.demux(stream):
            if packet.pts is None or packet.pts < 0:
                continue
            pts.append(packet.pts)
            end = max(end, packet.pts + (packet.duration or 0))
        time_base = Fraction(stream.time_base)
    if not pts:
        raise ValueError("no video frames")
    pts.sort()
    if end <= pts[-1]:
        end = pts[-1] + (max((pts[-1] - pts[0]) // (len(pts) - 1), 1) if len(pts) > 1 else 1)
    return FrameTimeline(time_base, pts, end)


def trim_window(trim: dict[str, int], timeline: FrameTimeline) -> tuple[Fraction, Fraction, int]:
    """(start_time, duration, frame_count) selecting frames [start_frame, end_frame) by their real timestamps."""
    pts, count = timeline.pts, len(timeline.pts)
    start, end = trim["start_frame"], min(trim["end_frame"], count)
    if start >= count:
        raise ValueError(f"trim starts at frame {start}, but the video has {count} frames")
    start_tick = pts[start]
    end_tick = pts[end] if end < count else timeline.end
    # A quarter tick keeps core's int(time / time_base) on the intended frame despite float rounding.
    start_time = (start_tick + Fraction(1, 4)) * timeline.time_base
    return start_time, (end_tick - start_tick) * timeline.time_base, end - start


class TrimmedVideoFromFile(InputImpl.VideoFromFile):
    """Core VideoFromFile with exact duration and frame count; core derives them from container metadata,
    which is wrong for streams that do not start at zero."""

    def __init__(self, file: str, *, start_time: float, duration: float, crop, frame_count: int):
        super().__init__(file, start_time=start_time, duration=duration, crop=crop)
        self._exact_duration = duration
        self._exact_frame_count = frame_count

    def get_duration(self) -> float:
        return self._exact_duration

    def get_frame_count(self) -> int:
        return self._exact_frame_count


def load_video(path: str, edit: dict[str, Any], muted: bool) -> Input.Video:
    rotate, mirror, crop = edit.get("rotate", 0), bool(edit.get("mirror")), edit.get("crop")
    trim = edit.get("trim")
    window = trim_window(trim, frame_timeline(path)) if trim else None
    display_rotated = bool(crop) and not rotate and not mirror and _display_rotation(path) != 0

    if not rotate and not mirror and not display_rotated:
        box = None
        if crop:
            width, height = InputImpl.VideoFromFile(path).get_dimensions()
            box = crop_to_pixels(crop, width, height)
        if window is None:
            video = InputImpl.VideoFromFile(path, crop=box)
        else:
            start_time, duration, count = window
            video = TrimmedVideoFromFile(path, start_time=float(start_time), duration=float(duration), crop=box, frame_count=count)
        return MutedVideo(video) if muted else video

    # Core cannot rotate or mirror, and its crop of display-rotated streams fails on save, so decode here.
    if window is None:
        source = InputImpl.VideoFromFile(path)
    else:
        source = InputImpl.VideoFromFile(path, start_time=float(window[0]), duration=float(window[1]))
    components = source.get_components()
    images = _transform(components.images, rotate // 90, mirror, crop)
    components.images = None
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=images,
            frame_rate=Fraction(components.frame_rate),
            audio=None if muted else components.audio,
            metadata=components.metadata,
        ),
        bit_depth=source.get_bit_depth(),
        color_space=source.get_color_space(),
    )


def _display_rotation(path: str) -> int:
    """Clockwise display rotation in degrees from the stream's display matrix, read from the first frame."""
    with av.open(path, mode="r") as container:
        frame = next(container.decode(video=0), None)
        return int(frame.rotation) % 360 if frame is not None and frame.rotation else 0


def _transform(images: torch.Tensor, quarter_turns: int, mirror: bool, crop: dict[str, Any] | None) -> torch.Tensor:
    """Rotate clockwise, mirror, then crop, one frame at a time into one output tensor."""
    height, width = images.shape[1:3]
    out_h, out_w = (width, height) if quarter_turns % 2 else (height, width)
    box = crop_to_pixels(crop, out_w, out_h)
    rect = normalize_crop_rect(*box, out_w, out_h) if box else None
    x, y, w, h = rect or (0, 0, out_w, out_h)
    if not quarter_turns and not mirror and rect is None:
        return images
    out = torch.empty((images.shape[0], h, w, images.shape[3]), dtype=images.dtype, device=images.device)
    for index in range(images.shape[0]):
        frame = images[index]
        if quarter_turns:
            frame = torch.rot90(frame, k=quarter_turns, dims=(1, 0))
        if mirror:
            frame = torch.flip(frame, dims=(1,))
        out[index] = frame[y:y + h, x:x + w]
    return out


class MutedVideo(Input.Video):
    """Wraps a video and drops its audio; frames are only decoded when a consumer asks."""

    def __init__(self, inner: Input.Video):
        self.inner = inner

    def get_components(self) -> Types.VideoComponents:
        return dataclasses.replace(self.inner.get_components(), audio=None)

    def save_to(
        self,
        path: Union[str, IO[bytes]],
        format: Types.VideoContainer = Types.VideoContainer.AUTO,
        codec: Types.VideoCodec = Types.VideoCodec.AUTO,
        metadata: Optional[dict] = None,
        bit_depth: int | None = None,
        crf: float | None = None,
        color_space: str | None = None,
        preset: str | None = None,
    ):
        options = dict(format=format, codec=codec, metadata=metadata, bit_depth=bit_depth, crf=crf, color_space=color_space, preset=preset)
        if isinstance(path, (str, os.PathLike)):
            suffix = os.path.splitext(os.fspath(path))[1] or ".mp4"
            with tempfile.TemporaryDirectory(prefix="aala-media-") as folder:
                staged = os.path.join(folder, f"staged{suffix}")
                self.inner.save_to(staged, **options)
                _copy_without_audio(staged, os.fspath(path), format)
        else:
            staged = io.BytesIO()
            self.inner.save_to(staged, **options)
            staged.seek(0)
            _copy_without_audio(staged, path, format)

    def as_trimmed(self, start_time: float | None = None, duration: float | None = None, strict_duration: bool = False) -> Input.Video | None:
        trimmed = self.inner.as_trimmed(start_time, duration, strict_duration)
        return MutedVideo(trimmed) if trimmed is not None else None

    def as_cropped(self, x: int = 0, y: int = 0, width: int = 0, height: int = 0) -> Input.Video:
        return MutedVideo(self.inner.as_cropped(x, y, width, height))

    def get_active_trim_window(self) -> tuple[float, float]:
        # The inherited stream source is this video saved already trimmed, so no window remains.
        return 0.0, 0.0

    def get_color_space(self) -> str:
        return self.inner.get_color_space()

    def get_dimensions(self) -> tuple[int, int]:
        return self.inner.get_dimensions()

    def get_bit_depth(self) -> int:
        return self.inner.get_bit_depth()

    def get_duration(self) -> float:
        return self.inner.get_duration()

    def get_frame_count(self) -> int:
        return self.inner.get_frame_count()

    def get_frame_rate(self) -> Fraction:
        return self.inner.get_frame_rate()

    def get_container_format(self) -> str:
        return self.inner.get_container_format()


def _copy_without_audio(source: Union[str, IO[bytes]], dest: Union[str, IO[bytes]], format: Types.VideoContainer) -> None:
    """Remuxes every non-audio stream without re-encoding."""
    with av.open(source, mode="r") as container:
        with av.open(dest, **get_open_write_kwargs(dest, container.format.name, format)) as output:
            for key, value in container.metadata.items():
                output.metadata[key] = value
            streams, filters = {}, {}
            for stream in container.streams:
                if stream.type == "audio" or stream.codec_context is None:
                    continue
                out_stream = output.add_stream_from_template(template=stream, opaque=True)
                hevc = isobmff_hevc_filter(output, stream, out_stream)
                if hevc is not None:
                    filters[stream] = hevc
                streams[stream] = out_stream
            for packet in container.demux(*streams):
                if packet.dts is None:
                    continue
                hevc = filters.get(packet.stream)
                for out_packet in filter_hevc_packet(hevc, packet) if hevc else (packet,):
                    out_packet.stream = streams[packet.stream]
                    output.mux(out_packet)
