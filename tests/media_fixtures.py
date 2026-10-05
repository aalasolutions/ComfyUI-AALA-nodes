from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image


def make_image(path: Path, size=(40, 20), orientation: int | None = None) -> Path:
    image = Image.new("RGB", size, (200, 30, 30))
    exif = Image.Exif()
    if orientation is not None:
        exif[0x0112] = orientation
    image.save(path, exif=exif)
    return path


def make_video(path: Path, frames: int = 12, rate: Fraction = Fraction(24000, 1001), with_audio: bool = True) -> Path:
    with av.open(str(path), mode="w") as container:
        video = container.add_stream("mpeg4", rate=rate)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        audio = container.add_stream("aac", rate=48000, layout="mono") if with_audio else None
        for index in range(frames):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), (index * 10) % 256, dtype=np.uint8), format="rgb24")
            for packet in video.encode(frame):
                container.mux(packet)
        for packet in video.encode():
            container.mux(packet)
        if audio is not None:
            samples = np.zeros((1, 1024), dtype=np.float32)
            for index in range(24):
                chunk = av.AudioFrame.from_ndarray(samples, format="fltp", layout="mono")
                chunk.sample_rate = 48000
                chunk.pts = index * 1024
                for packet in audio.encode(chunk):
                    container.mux(packet)
            for packet in audio.encode():
                container.mux(packet)
    return path


def make_wav(path: Path, seconds: float = 0.5, rate: int = 22050) -> Path:
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("pcm_s16le", rate=rate, layout="stereo")
        frame = av.AudioFrame.from_ndarray(np.zeros((1, int(rate * seconds) * 2), dtype=np.int16), format="s16", layout="stereo")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


class _UnseekableWriter:
    def __init__(self, handle):
        self.handle = handle

    def write(self, data):
        return self.handle.write(data)

    def seekable(self):
        return False

    def flush(self):
        pass


def make_streamed_flac(path: Path, seconds: float = 3.0, rate: int = 8000) -> Path:
    """FLAC written to a pipe-like writer, so the header carries no duration."""
    with open(path, "wb") as handle, av.open(_UnseekableWriter(handle), mode="w", format="flac") as container:
        stream = container.add_stream("flac", rate=rate, layout="mono")
        frame = av.AudioFrame.from_ndarray(np.zeros((1, int(rate * seconds)), dtype=np.int16), format="s16", layout="mono")
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


def make_offset_video(path: Path, start_seconds: int = 10, frames: int = 24, rate: int = 24) -> Path:
    """Video whose first timestamp is start_seconds; frame i has brightness i * 10."""
    with av.open(str(path), mode="w") as container:
        video = container.add_stream("mpeg4", rate=rate)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        for index in range(frames):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), (index * 10) % 256, dtype=np.uint8), format="rgb24")
            frame.pts = start_seconds * rate + index
            for packet in video.encode(frame):
                container.mux(packet)
        for packet in video.encode():
            container.mux(packet)
    return path


def make_split_video(path: Path, frames: int = 6, rate: int = 24) -> Path:
    """64x48 video, white left half and black right half, no audio."""
    pixels = np.zeros((48, 64, 3), dtype=np.uint8)
    pixels[:, :32] = 255
    with av.open(str(path), mode="w") as container:
        video = container.add_stream("mpeg4", rate=rate)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        for _ in range(frames):
            for packet in video.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in video.encode():
            container.mux(packet)
    return path


def make_rotated_video(path: Path, frames: int = 6, degrees: int = 90) -> Path:
    """64x48 coded video (white left half) with a display-matrix rotation, like phone footage."""
    pixels = np.zeros((48, 64, 3), dtype=np.uint8)
    pixels[:, :32] = 255
    with av.open(str(path), mode="w") as container:
        video = container.add_stream("mpeg4", rate=24)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        video.set_display_rotation(degrees)
        for _ in range(frames):
            for packet in video.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in video.encode():
            container.mux(packet)
    return path


def make_vfr_video(path: Path, gaps_ms=(40, 40, 120, 40, 200, 40, 40, 80, 40, 40)) -> Path:
    """Variable frame rate video in a 1/1000 time base; frame i has brightness i * 20."""
    with av.open(str(path), mode="w") as container:
        video = container.add_stream("mpeg4", rate=25)
        video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
        video.codec_context.time_base = Fraction(1, 1000)
        pts = 0
        for index, gap in enumerate(gaps_ms):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), index * 20, dtype=np.uint8), format="rgb24")
            frame.pts, frame.time_base = pts, Fraction(1, 1000)
            for packet in video.encode(frame):
                container.mux(packet)
            pts += gap
        for packet in video.encode():
            container.mux(packet)
    return path
