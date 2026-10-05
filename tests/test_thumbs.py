import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from PIL import Image

from aala_media.server.fs import FsError
from aala_media.server.thumbs import MediaCache
from media_fixtures import make_image, make_offset_video, make_streamed_flac, make_video, make_wav


class MediaCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = MediaCache(self.root / "cache")

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_thumb_is_webp_and_exif_rotated(self):
        target = self.cache.thumb(str(make_image(self.root / "r.jpg", size=(400, 200), orientation=6)), 128)
        with Image.open(target) as thumb:
            self.assertEqual(thumb.format, "WEBP")
            self.assertEqual(thumb.size, (64, 128))

    def test_size_snaps_to_supported_sizes(self):
        image = str(make_image(self.root / "big.png", size=(1000, 1000)))
        with Image.open(self.cache.thumb(image, 300)) as thumb:
            self.assertEqual(thumb.size, (256, 256))

    def test_video_poster_and_frame(self):
        video = str(make_video(self.root / "clip.mp4"))
        with Image.open(self.cache.thumb(video, 128)) as poster:
            self.assertEqual(poster.size, (64, 48))
        early = self.cache.frame(video, 0.0, 64)
        late = self.cache.frame(video, 0.4, 64)
        self.assertNotEqual(early, late)
        with Image.open(early) as first, Image.open(late) as second:
            self.assertLess(first.convert("L").getpixel((10, 10)), second.convert("L").getpixel((10, 10)))

    def test_peaks_shape_and_range(self):
        payload = self.cache.peaks(str(make_wav(self.root / "tone.wav", seconds=1.0)), 64)
        self.assertEqual((payload["sample_rate"], payload["channels"]), (22050, 2))
        self.assertAlmostEqual(payload["duration"], 1.0, places=2)
        self.assertLessEqual(len(payload["peaks"]), 128)
        self.assertGreaterEqual(len(payload["peaks"]), 126)
        self.assertTrue(all(-1.0 <= value <= 1.0 for value in payload["peaks"]))

    def brightness(self, target):
        with Image.open(target) as image:
            return image.convert("L").getpixel((10, 10))

    def test_peaks_bucket_count_is_exact(self):
        wav = str(make_wav(self.root / "tone.wav", seconds=1.0))
        self.assertEqual(len(self.cache.peaks(wav, 64)["peaks"]), 128)
        short = str(make_wav(self.root / "short.wav", seconds=0.01))
        self.assertLessEqual(len(self.cache.peaks(short, 1024)["peaks"]), 2048)

    def test_peaks_without_container_duration(self):
        payload = self.cache.peaks(str(make_streamed_flac(self.root / "pipe.flac", seconds=3.0)), 32)
        self.assertEqual(len(payload["peaks"]), 64)
        self.assertAlmostEqual(payload["duration"], 3.0, places=2)

    def test_frame_respects_stream_start_time(self):
        video = str(make_offset_video(self.root / "offset.mp4"))
        first = self.brightness(self.cache.frame(video, 0.0, 64))
        later = self.brightness(self.cache.frame(video, 0.5, 64))
        self.assertLess(first, 20)
        self.assertGreater(later, 80)

    def test_frame_past_end_returns_last_frame(self):
        for video in (str(make_video(self.root / "clip.mp4")), str(make_offset_video(self.root / "offset.mp4"))):
            self.assertGreater(self.brightness(self.cache.frame(video, 99.0, 64)), 80, video)
        with self.assertRaises(FsError) as caught:
            self.cache.frame(video, 1e300, 64)
        self.assertEqual(caught.exception.code, "bad_request")

    def test_concurrent_eviction_never_breaks_requests(self):
        cache = MediaCache(self.root / "race", budget_bytes=1)
        files = [str(make_wav(self.root / f"r{index}.wav", seconds=0.2)) for index in range(5)]
        errors = []

        def worker():
            for round_index in range(20):
                try:
                    cache.peaks(files[round_index % len(files)], 16 + round_index)
                except Exception as error:
                    errors.append(repr(error))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])

    def test_cache_hit_and_invalidation_on_change(self):
        image = make_image(self.root / "a.png")
        first = self.cache.thumb(str(image), 128)
        self.assertEqual(self.cache.thumb(str(image), 128), first)
        make_image(image, size=(80, 20))
        later = time.time() + 5
        os.utime(image, (later, later))
        second = self.cache.thumb(str(image), 128)
        self.assertNotEqual(second, first)

    def test_eviction_keeps_newest_within_budget(self):
        cache = MediaCache(self.root / "small", budget_bytes=1)
        only = cache.thumb(str(make_image(self.root / "only.png")), 128)
        self.assertTrue(only.exists(), "a freshly written entry is never evicted")
        os.utime(only, (1, 1))
        recent = cache.thumb(str(make_image(self.root / "recent.png", size=(30, 30))), 128)
        new = cache.thumb(str(make_image(self.root / "new.png", size=(60, 30))), 128)
        self.assertFalse(only.exists())
        self.assertTrue(recent.exists(), "entries used within the grace period are kept")
        self.assertTrue(new.exists())

    def test_errors(self):
        audio = str(make_wav(self.root / "a.wav"))
        broken = self.root / "broken.mp4"
        broken.write_bytes(b"not a video")
        cases = [
            (lambda: self.cache.thumb(audio, 128), "bad_request"),
            (lambda: self.cache.frame(str(make_image(self.root / "i.png")), 0, 64), "bad_request"),
            (lambda: self.cache.thumb(str(broken), 128), "unreadable"),
            (lambda: self.cache.thumb(str(self.root / "none.png"), 128), "not_found"),
        ]
        for call, code in cases:
            with self.assertRaises(FsError) as caught:
                call()
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(list((self.root / "cache" / "thumbs").glob(".partial-*")), [])


if __name__ == "__main__":
    unittest.main()
