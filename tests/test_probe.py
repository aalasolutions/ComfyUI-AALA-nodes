import tempfile
import unittest
from pathlib import Path

from aala_media.server.probe import probe, probe_many
from media_fixtures import make_image, make_video, make_wav


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_dimensions_respect_exif_rotation(self):
        plain = probe(str(make_image(self.root / "plain.jpg")))
        rotated = probe(str(make_image(self.root / "rotated.jpg", orientation=6)))
        self.assertEqual((plain["width"], plain["height"]), (40, 20))
        self.assertEqual((rotated["width"], rotated["height"]), (20, 40))
        self.assertGreater(plain["size"], 0)

    def test_video_metadata_keeps_fraction_frame_rate(self):
        meta = probe(str(make_video(self.root / "clip.mp4")))
        self.assertEqual((meta["width"], meta["height"]), (64, 48))
        self.assertEqual(meta["fps"], "24000/1001")
        self.assertTrue(meta["has_audio"])
        self.assertEqual(meta["sample_rate"], 48000)
        self.assertEqual(meta["channels"], 1)
        self.assertGreater(meta["duration"], 0)
        self.assertGreater(meta["frames"], 0)

    def test_video_without_audio(self):
        meta = probe(str(make_video(self.root / "silent.mp4", with_audio=False)))
        self.assertFalse(meta["has_audio"])
        self.assertNotIn("sample_rate", meta)

    def test_audio_metadata(self):
        meta = probe(str(make_wav(self.root / "tone.wav")))
        self.assertEqual((meta["sample_rate"], meta["channels"]), (22050, 2))
        self.assertAlmostEqual(meta["duration"], 0.5, places=2)

    def test_missing_relative_and_unreadable(self):
        self.assertEqual(probe(str(self.root / "gone.png")), {"missing": True})
        self.assertEqual(probe("relative.png"), {"missing": True})
        broken = self.root / "broken.mp4"
        broken.write_bytes(b"not a video")
        self.assertIn("unreadable", probe(str(broken))["error"])

    def test_probe_many_dedupes(self):
        image = str(make_image(self.root / "a.png"))
        result = probe_many([image, image, str(self.root / "b.png")])
        self.assertEqual(list(result), [image, str(self.root / "b.png")])


if __name__ == "__main__":
    unittest.main()
