from __future__ import annotations

from typing import Any

import av
import numpy as np
import torch


def load_audio(path: str, edit: dict[str, Any]) -> dict[str, Any]:
    """Decodes the first audio stream to float32 and slices it by trim {start, end} seconds."""
    with av.open(path, mode="r") as container:
        if not container.streams.audio:
            raise ValueError(f"No audio stream in {path}")
        stream = container.streams.audio[0]
        sample_rate = stream.codec_context.sample_rate
        trim = edit.get("trim")
        start = round(trim["start"] * sample_rate) if trim else 0
        end = round(trim["end"] * sample_rate) if trim else None

        resampler = av.audio.resampler.AudioResampler(format="fltp")
        chunks: list[np.ndarray] = []
        decoded = 0
        for frame in container.decode(stream):
            for planar in resampler.resample(frame):
                chunk = planar.to_ndarray()
                chunks.append(chunk)
                decoded += chunk.shape[1]
            if end is not None and decoded >= end:
                break
        for planar in resampler.resample(None):
            chunks.append(planar.to_ndarray())

    if not chunks:
        raise ValueError(f"No audio frames decoded from {path}")
    samples = np.concatenate(chunks, axis=1)
    if start >= samples.shape[1]:
        length = samples.shape[1] / sample_rate
        raise ValueError(f"Audio trim starts at {trim['start']}s, after the end of {path} ({length:.3f}s)")
    samples = samples[:, start:end]
    waveform = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32)).unsqueeze(0)
    return {"waveform": waveform, "sample_rate": int(sample_rate)}
