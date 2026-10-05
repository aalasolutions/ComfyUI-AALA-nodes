import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # ComfyUI root, for comfy_api and torch

import av
import numpy as np
from PIL import Image

from aala_media.decode.audio import load_audio
from aala_media.decode.crop import crop_to_pixels
from aala_media.decode.image import load_image
from aala_media.decode.video import FrameTimeline, MutedVideo, frame_timeline, load_video, trim_window
from comfy_api.latest import InputImpl
from media_fixtures import (
    make_image,
    make_offset_video,
    make_rotated_video,
    make_split_video,
    make_vfr_video,
    make_video,
    make_wav,
)


def _quadrant_image(path: Path) -> Path:
    """40x20 image: left half red, right half blue."""
    pixels = np.zeros((20, 40, 3), dtype=np.uint8)
    pixels[:, :20] = (255, 0, 0)
    pixels[:, 20:] = (0, 0, 255)
    Image.fromarray(pixels).save(path)
    return path


class CropTests(unittest.TestCase):
    def test_normalized_to_pixels(self):
        self.assertEqual(crop_to_pixels({"x": 0.1, "y": 0.25, "w": 0.5, "h": 0.5}, 1920, 1080), (192, 270, 960, 540))
        self.assertIsNone(crop_to_pixels({"x": 0, "y": 0, "w": 1, "h": 1}, 64, 48))
        self.assertIsNone(crop_to_pixels(None, 64, 48))

    def test_clamped_to_frame(self):
        self.assertEqual(crop_to_pixels({"x": 0.9, "y": 0.9, "w": 0.1000001, "h": 0.1000001}, 10, 10), (9, 9, 1, 1))


class ImageDecodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tensor_shape_and_range(self):
        tensor = load_image(str(make_image(self.root / "a.png")), {})
        self.assertEqual(tuple(tensor.shape), (1, 20, 40, 3))
        self.assertEqual(str(tensor.dtype), "torch.float32")
        self.assertAlmostEqual(float(tensor[0, 0, 0, 0]), 200 / 255, places=5)

    def test_exif_orientation_applied(self):
        tensor = load_image(str(make_image(self.root / "r.jpg", orientation=6)), {})
        self.assertEqual(tuple(tensor.shape), (1, 40, 20, 3))

    def test_rotate_clockwise_and_mirror(self):
        path = str(_quadrant_image(self.root / "q.png"))
        rotated = load_image(path, {"rotate": 90})
        self.assertEqual(tuple(rotated.shape), (1, 40, 20, 3))
        self.assertGreater(float(rotated[0, 0, 0, 0]), 0.9)  # left (red) moves to the top
        self.assertGreater(float(rotated[0, -1, 0, 2]), 0.9)
        mirrored = load_image(path, {"mirror": True})
        self.assertGreater(float(mirrored[0, 0, 0, 2]), 0.9)  # blue now on the left

    def test_crop_after_rotate_and_mirror(self):
        path = str(_quadrant_image(self.root / "q.png"))
        cropped = load_image(path, {"crop": {"x": 0.5, "y": 0, "w": 0.5, "h": 0.5}})
        self.assertEqual(tuple(cropped.shape), (1, 10, 20, 3))
        self.assertGreater(float(cropped[0, :, :, 2].min()), 0.9)  # right half only: blue
        rotated = load_image(path, {"rotate": 270, "mirror": True, "crop": {"x": 0, "y": 0, "w": 1, "h": 0.5}})
        self.assertEqual(tuple(rotated.shape), (1, 20, 20, 3))
        self.assertGreater(float(rotated[0, :, :, 2].min()), 0.9)  # counter-clockwise puts blue on top

    def test_animated_gif_first_frame(self):
        frames = [Image.new("RGB", (8, 8), color) for color in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
        path = self.root / "anim.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=50, loop=0)
        tensor = load_image(str(path), {})
        self.assertEqual(tuple(tensor.shape), (1, 8, 8, 3))
        self.assertGreater(float(tensor[0, 0, 0, 0]), 0.9)
        self.assertLess(float(tensor[0, 0, 0, 1]), 0.1)

    def test_sixteen_bit_and_float_gray(self):
        gray16 = self.root / "gray16.png"
        Image.fromarray(np.full((4, 6), 0x8080, dtype=np.uint16)).save(gray16)
        with Image.open(gray16) as opened:
            self.assertEqual(opened.mode, "I;16")
        tensor = load_image(str(gray16), {"rotate": 90})
        self.assertEqual(tuple(tensor.shape), (1, 6, 4, 3))
        self.assertAlmostEqual(float(tensor.mean()), 0x8080 / 65535, places=4)
        float_tif = self.root / "f.tif"
        Image.new("F", (6, 4), 0.5).save(float_tif)
        self.assertAlmostEqual(float(load_image(str(float_tif), {}).mean()), 0.5, places=5)

    def test_thirty_two_bit_gray_scales_by_used_range(self):
        for name, value, expected in (("i8.tif", 128, 128 / 255), ("i16.tif", 0x8080, 0x8080 / 65535)):
            path = self.root / name
            Image.fromarray(np.full((4, 6), value, dtype=np.int32), mode="I").save(path)
            with Image.open(path) as opened:
                self.assertEqual(opened.mode, "I")
            self.assertAlmostEqual(float(load_image(str(path), {}).mean()), expected, places=4)

    def test_alpha_dropped(self):
        path = self.root / "alpha.png"
        Image.new("RGBA", (6, 4), (10, 20, 30, 0)).save(path)
        tensor = load_image(str(path), {})
        self.assertEqual(tuple(tensor.shape), (1, 4, 6, 3))


class VideoDecodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_plain_video_is_lazy_file(self):
        video = load_video(str(make_video(self.root / "v.mp4")), {}, False)
        self.assertIsInstance(video, InputImpl.VideoFromFile)
        self.assertEqual(video.get_dimensions(), (64, 48))
        self.assertEqual(video.get_frame_rate(), Fraction(24000, 1001))
        components = video.get_components()
        self.assertEqual(components.images.shape[0], 12)
        self.assertIsNotNone(components.audio)

    def test_trim_window_uses_frame_timestamps(self):
        timeline = FrameTimeline(Fraction(1, 24000), [index * 1001 for index in range(10)], 10010)
        start, duration, count = trim_window({"start_frame": 3, "end_frame": 7}, timeline)
        self.assertEqual(start, Fraction(3003 * 4 + 1, 4 * 24000))
        self.assertEqual(duration, Fraction(4004, 24000))
        self.assertEqual(count, 4)
        _, duration, count = trim_window({"start_frame": 8, "end_frame": 50}, timeline)
        self.assertEqual((duration, count), (Fraction(2002, 24000), 2))
        with self.assertRaisesRegex(ValueError, "has 10 frames"):
            trim_window({"start_frame": 10, "end_frame": 12}, timeline)

    def test_offset_stream_duration_frame_count_and_save(self):
        path = str(make_offset_video(self.root / "o.mp4", start_seconds=10, frames=24))
        for start, end in ((0, 5), (10, 20), (20, 24)):
            video = load_video(path, {"trim": {"start_frame": start, "end_frame": end}}, False)
            self.assertEqual(video.get_components().images.shape[0], end - start)
            self.assertAlmostEqual(video.get_duration(), (end - start) / 24, places=6)
            self.assertEqual(video.get_frame_count(), end - start)
            out = self.root / f"o_{start}.mp4"
            video.save_to(str(out))
            with av.open(str(out)) as container:
                self.assertEqual(sum(1 for _ in container.decode(video=0)), end - start)

    def test_vfr_trim_uses_real_timestamps(self):
        path = str(make_vfr_video(self.root / "vfr.mp4"))
        self.assertEqual(len(frame_timeline(path).pts), 10)
        for start, end in ((2, 6), (5, 10), (0, 3)):
            video = load_video(path, {"trim": {"start_frame": start, "end_frame": end}}, False)
            images = video.get_components().images
            self.assertEqual(images.shape[0], end - start, (start, end))
            self.assertAlmostEqual(float(images[0].mean()) * 255, start * 20, delta=3)
            self.assertAlmostEqual(float(images[-1].mean()) * 255, (end - 1) * 20, delta=3)
            self.assertEqual(video.get_frame_count(), end - start)

    def test_display_rotated_crop_uses_decode_path_and_saves(self):
        path = str(make_rotated_video(self.root / "phone.mp4"))
        video = load_video(path, {"crop": {"x": 0, "y": 0, "w": 0.5, "h": 0.5}, "trim": {"start_frame": 1, "end_frame": 5}}, False)
        self.assertIsInstance(video, InputImpl.VideoFromComponents)
        self.assertEqual(video.get_dimensions(), (24, 32))
        out = self.root / "phone_out.mp4"
        video.save_to(str(out))
        with av.open(str(out)) as container:
            stream = container.streams.video[0]
            self.assertEqual((stream.width, stream.height), (24, 32))
            self.assertEqual(sum(1 for _ in container.decode(video=0)), 4)

    def test_rotate_path_keeps_source_color_and_depth(self):
        path = str(make_video(self.root / "v.mp4"))
        source = InputImpl.VideoFromFile(path)
        video = load_video(path, {"rotate": 90}, False)
        self.assertEqual(video.get_color_space(), source.get_color_space())
        self.assertEqual(video.get_bit_depth(), source.get_bit_depth())
        self.assertTrue(video.get_components().images.is_contiguous())

    def test_muted_trimmed_video_works_with_core_rescale(self):
        from comfy_api_nodes.util import conversions

        path = str(make_video(self.root / "v.mp4", frames=24))
        video = load_video(path, {"trim": {"start_frame": 6, "end_frame": 18}}, True)
        self.assertEqual(video.get_active_trim_window(), (0.0, 0.0))
        scaled = conversions._apply_video_scale(video, (32, 24))
        components = scaled.get_components()
        self.assertEqual(components.images.shape[0], 12)
        self.assertIsNone(components.audio)

    def test_trim_is_frame_accurate(self):
        path = str(make_video(self.root / "v.mp4", frames=24))
        for start, end in ((3, 7), (0, 1), (10, 24), (23, 24)):
            images = load_video(path, {"trim": {"start_frame": start, "end_frame": end}}, False).get_components().images
            self.assertEqual(images.shape[0], end - start, (start, end))
            self.assertAlmostEqual(float(images[0].mean()) * 255, (start * 10) % 256, delta=3)
            self.assertAlmostEqual(float(images[-1].mean()) * 255, ((end - 1) * 10) % 256, delta=3)

    def test_trim_counts_from_first_frame_of_offset_stream(self):
        path = str(make_offset_video(self.root / "o.mp4", start_seconds=10, frames=24))
        images = load_video(path, {"trim": {"start_frame": 2, "end_frame": 5}}, False).get_components().images
        self.assertEqual(images.shape[0], 3)
        self.assertAlmostEqual(float(images[0].mean()) * 255, 20, delta=3)

    def test_crop_converts_to_even_pixels(self):
        path = str(make_video(self.root / "v.mp4"))
        video = load_video(path, {"crop": {"x": 0.25, "y": 0.0, "w": 0.5, "h": 0.5}}, False)
        self.assertEqual(video.get_dimensions(), (32, 24))
        odd = load_video(path, {"crop": {"x": 0, "y": 0, "w": 33 / 64, "h": 25 / 48}}, False)
        self.assertEqual(tuple(odd.get_components().images.shape[1:3]), (24, 32))

    def test_rotate_and_mirror_decode_path(self):
        path = str(make_split_video(self.root / "s.mp4"))
        rotated = load_video(path, {"rotate": 90}, False)
        self.assertEqual(rotated.get_dimensions(), (48, 64))
        self.assertIsInstance(rotated.get_frame_rate(), Fraction)
        images = rotated.get_components().images
        self.assertGreater(float(images[0, 5].mean()), 0.9)  # white left half is now on top
        self.assertLess(float(images[0, -5].mean()), 0.1)
        mirrored = load_video(path, {"mirror": True, "crop": {"x": 0.5, "y": 0, "w": 0.5, "h": 1}}, False)
        images = mirrored.get_components().images
        self.assertEqual(tuple(images.shape[1:3]), (48, 32))
        self.assertGreater(float(images.mean()), 0.9)  # mirrored right half is the white half

    def test_rotate_keeps_trim_and_mute(self):
        path = str(make_video(self.root / "v.mp4", frames=24))
        video = load_video(path, {"rotate": 180, "trim": {"start_frame": 4, "end_frame": 10}}, True)
        components = video.get_components()
        self.assertEqual(components.images.shape[0], 6)
        self.assertIsNone(components.audio)
        self.assertEqual(components.frame_rate, Fraction(24000, 1001))

    def test_muted_video_is_lazy_and_drops_audio(self):
        path = str(make_video(self.root / "v.mp4"))
        with mock.patch.object(InputImpl.VideoFromFile, "get_components", side_effect=AssertionError("decoded")):
            video = load_video(path, {}, True)
            self.assertIsInstance(video, MutedVideo)
            self.assertEqual(video.get_dimensions(), (64, 48))
            self.assertEqual(video.get_frame_count(), 12)
            self.assertEqual(video.get_frame_rate(), Fraction(24000, 1001))
            out = self.root / "muted.mp4"
            video.save_to(str(out))
        self.assertIsNone(video.get_components().audio)
        with av.open(str(out)) as container:
            self.assertEqual(len(container.streams.audio), 0)
            self.assertEqual(sum(1 for _ in container.decode(video=0)), 12)

    def test_muted_save_to_buffer_and_trimmed(self):
        import io

        path = str(make_video(self.root / "v.mp4", frames=24))
        video = load_video(path, {"trim": {"start_frame": 2, "end_frame": 14}}, True)
        buffer = io.BytesIO()
        video.save_to(buffer)
        buffer.seek(0)
        with av.open(buffer) as container:
            self.assertEqual(len(container.streams.audio), 0)
            self.assertEqual(sum(1 for _ in container.decode(video=0)), 12)
        self.assertIsInstance(video.as_trimmed(0, 0.1), MutedVideo)


class AudioDecodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_audio(self):
        audio = load_audio(str(make_wav(self.root / "a.wav", seconds=0.5, rate=22050)), {})
        self.assertEqual(audio["sample_rate"], 22050)
        self.assertEqual(tuple(audio["waveform"].shape), (1, 2, 11025))
        self.assertEqual(str(audio["waveform"].dtype), "torch.float32")

    def test_trim_past_end_names_file(self):
        path = str(make_wav(self.root / "a.wav", seconds=0.5, rate=22050))
        with self.assertRaisesRegex(ValueError, "a.wav"):
            load_audio(path, {"trim": {"start": 2.0, "end": 3.0}})

    def test_trim_slices_by_sample(self):
        audio = load_audio(str(make_wav(self.root / "a.wav", seconds=0.5, rate=22050)), {"trim": {"start": 0.1, "end": 0.3}})
        self.assertEqual(tuple(audio["waveform"].shape), (1, 2, 4410))


if __name__ == "__main__":
    unittest.main()
