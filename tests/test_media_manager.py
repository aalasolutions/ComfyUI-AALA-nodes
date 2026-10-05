import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # ComfyUI root, for comfy_api and torch

from aala_media.decode.video import MutedVideo
from aala_media.nodes.media_manager import MediaManager
from aala_media.state import default_state, default_state_json
from media_fixtures import make_image, make_video, make_wav


def _item(path, kind, active=True, **fields):
    item = {"id": os.path.basename(str(path)) + kind, "path": str(path), "kind": kind, "active": active, "meta": None, "edit": {}}
    if kind != "image":
        item["muted"] = False
    item.update(fields)
    return item


def _state(image=(), video=(), audio=()):
    state = default_state()
    state["groups"] = {"image": list(image), "video": list(video), "audio": list(audio)}
    return json.dumps(state)


class MediaManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.image = make_image(self.root / "a.png")
        self.wide = make_image(self.root / "b.png", size=(30, 10))
        self.video = make_video(self.root / "v.mp4")
        self.audio = make_wav(self.root / "a.wav")

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_state_outputs_empty_lists(self):
        result = MediaManager.execute(default_state_json())
        self.assertEqual(result.args, ([], [], []))
        self.assertEqual(result.ui, {"missing": [], "unreadable": []})

    def test_active_items_in_group_order(self):
        state = _state(
            image=[_item(self.wide, "image"), _item(self.image, "image", active=False), _item(self.image, "image")],
            video=[_item(self.video, "video", split_of=None, part=None, parts=None)],
            audio=[_item(self.audio, "audio")],
        )
        images, videos, audios = MediaManager.execute(state).args
        self.assertEqual([tuple(image.shape) for image in images], [(1, 10, 30, 3), (1, 20, 40, 3)])
        self.assertEqual(len(videos), 1)
        self.assertEqual(videos[0].get_dimensions(), (64, 48))
        self.assertEqual(tuple(audios[0]["waveform"].shape)[:2], (1, 2))

    def test_muted_items(self):
        state = _state(
            video=[_item(self.video, "video", muted=True)],
            audio=[_item(self.audio, "audio", muted=True), _item(self.audio, "audio")],
        )
        _, videos, audios = MediaManager.execute(state).args
        self.assertIsInstance(videos[0], MutedVideo)
        self.assertEqual(len(audios), 1)

    def test_missing_files_skipped_and_reported(self):
        gone = str(self.root / "gone.png")
        state = _state(image=[_item(gone, "image"), _item(self.image, "image")], audio=[_item("relative.wav", "audio")])
        result = MediaManager.execute(state)
        self.assertEqual(len(result.args[0]), 1)
        self.assertEqual(result.args[2], [])
        self.assertEqual(result.ui, {"missing": [gone, "relative.wav"], "unreadable": []})

    @unittest.skipIf(os.geteuid() == 0, "root can read any file")
    def test_unreadable_files_skipped_and_reported(self):
        locked = make_image(self.root / "locked.png")
        os.chmod(locked, 0)
        try:
            result = MediaManager.execute(_state(image=[_item(locked, "image"), _item(self.image, "image")]))
        finally:
            os.chmod(locked, 0o644)
        self.assertEqual(len(result.args[0]), 1)
        self.assertEqual(result.ui, {"missing": [], "unreadable": [str(locked)]})

    @unittest.skipIf(os.geteuid() == 0, "root can read any file")
    def test_fingerprint_changes_when_file_becomes_readable(self):
        locked = make_image(self.root / "relock.png")
        state = _state(image=[_item(locked, "image")])
        os.chmod(locked, 0)
        try:
            unreadable = MediaManager.fingerprint_inputs(state)
        finally:
            os.chmod(locked, 0o644)
        self.assertNotEqual(MediaManager.fingerprint_inputs(state), unreadable)

    def test_undecodable_file_raises_naming_it(self):
        broken = self.root / "broken.png"
        broken.write_bytes(b"not an image")
        with self.assertRaisesRegex(RuntimeError, "broken.png"):
            MediaManager.execute(_state(image=[_item(broken, "image")]))

    def test_nul_path_rejected_and_fingerprint_safe(self):
        state = _state(image=[_item("/tmp/a\x00b.png", "image")])
        self.assertIn("NUL", MediaManager.validate_inputs(media_state=state))
        self.assertIsInstance(MediaManager.fingerprint_inputs(media_state=state), str)

    def test_non_finite_numbers_rejected(self):
        nan_crop = _state(image=[_item(self.image, "image", edit={"crop": {"x": 0, "y": 0, "w": float("nan"), "h": 0.5}})])
        self.assertIn("crop", MediaManager.validate_inputs(media_state=nan_crop))
        inf_trim = _state(audio=[_item(self.audio, "audio", edit={"trim": {"start": 0, "end": float("inf")}})])
        self.assertIn("trim", MediaManager.validate_inputs(media_state=inf_trim))

    def test_fingerprint_follows_file_changes(self):
        state = _state(image=[_item(self.image, "image")], video=[_item(self.video, "video")])
        first = MediaManager.fingerprint_inputs(media_state=state)
        self.assertEqual(first, MediaManager.fingerprint_inputs(media_state=state))
        stat = os.stat(self.image)
        os.utime(self.image, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        self.assertNotEqual(first, MediaManager.fingerprint_inputs(media_state=state))

    def test_fingerprint_follows_edits_and_ignores_inactive(self):
        base = MediaManager.fingerprint_inputs(media_state=_state(image=[_item(self.image, "image")]))
        edited = _state(image=[_item(self.image, "image", edit={"rotate": 90})])
        self.assertNotEqual(base, MediaManager.fingerprint_inputs(media_state=edited))
        with_inactive = _state(image=[_item(self.image, "image"), _item(self.wide, "image", active=False)])
        self.assertEqual(base, MediaManager.fingerprint_inputs(media_state=with_inactive))

    def test_validate_inputs(self):
        self.assertTrue(MediaManager.validate_inputs(media_state=default_state_json()))
        bad = _state(image=[_item(self.image, "image", muted=False)])
        self.assertIn("does not apply", MediaManager.validate_inputs(media_state=bad))
        self.assertIsInstance(MediaManager.fingerprint_inputs(media_state="{bad"), str)


if __name__ == "__main__":
    unittest.main()
