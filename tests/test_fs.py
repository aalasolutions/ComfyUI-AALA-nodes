import os
import stat
import tempfile
import unittest
from pathlib import Path

from aala_media.server.fs import FsError, file_for_streaming, list_directory, places


def _touch(path: Path, size: int = 1) -> None:
    path.write_bytes(b"x" * size)


class ListDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for name in ("clip10.mp4", "clip2.mp4", "Photo.PNG", "song.wav", "notes.txt", ".hidden.png"):
            _touch(self.root / name)
        (self.root / "sub").mkdir()
        (self.root / ".secret").mkdir()
        (self.root / "Final Cut.fcpbundle").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def names(self, **kwargs):
        return [entry["name"] for entry in list_directory(str(self.root), **kwargs)["entries"]]

    def test_folders_first_then_natural_order(self):
        self.assertEqual(self.names(), ["sub", "clip2.mp4", "clip10.mp4", "Photo.PNG", "song.wav"])

    def test_entry_shapes(self):
        result = list_directory(str(self.root))
        folder, video = result["entries"][0], result["entries"][1]
        self.assertEqual(folder, {"type": "dir", "name": "sub", "path": str(self.root / "sub"), "mtime": folder["mtime"]})
        self.assertEqual(video["kind"], "video")
        self.assertEqual(video["size"], 1)

    def test_non_media_and_packages_are_skipped(self):
        result = list_directory(str(self.root))
        self.assertEqual(result["skipped"], 2)
        self.assertNotIn("Final Cut.fcpbundle", self.names())

    def test_hidden_entries_never_listed(self):
        self.assertNotIn(".hidden.png", self.names())
        self.assertNotIn(".secret", self.names())
        self.assertFsError("hidden", 403, str(self.root / ".secret"))

    def test_kind_filter_keeps_folders(self):
        self.assertEqual(self.names(kinds={"audio"}), ["sub", "song.wav"])

    def test_whole_folder_in_one_response(self):
        for index in range(60):
            _touch(self.root / f"img{index}.png")
        self.assertEqual(len(list_directory(str(self.root))["entries"]), 65)

    def test_parent_and_root(self):
        self.assertEqual(list_directory(str(self.root))["parent"], str(self.root.parent))
        self.assertIsNone(list_directory("/")["parent"])

    def test_tilde_expands(self):
        self.assertEqual(list_directory("~")["path"], str(Path.home()))

    def assertFsError(self, code, status, *args, **kwargs):
        with self.assertRaises(FsError) as caught:
            list_directory(*args, **kwargs)
        self.assertEqual((caught.exception.code, caught.exception.status), (code, status))

    def test_errors(self):
        self.assertFsError("not_found", 404, str(self.root / "missing"))
        self.assertFsError("not_a_directory", 400, str(self.root / "song.wav"))
        self.assertFsError("bad_request", 400, "relative/path")
        self.assertFsError("bad_request", 400, "")

    @unittest.skipIf(os.geteuid() == 0, "root ignores permissions")
    def test_permission_denied(self):
        locked = self.root / "locked"
        locked.mkdir()
        locked.chmod(0)
        try:
            self.assertFsError("permission_denied", 403, str(locked))
        finally:
            locked.chmod(stat.S_IRWXU)


class FileForStreamingTests(unittest.TestCase):
    def test_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "a.png"
            _touch(target)
            (root / "folder.png").mkdir()
            (root / ".cache").mkdir()
            for name in ("notes.txt", ".a.png", ".cache/b.png"):
                _touch(root / name)
            (root / "link.png").symlink_to(root / "notes.txt")
            (root / "cachelink").symlink_to(root / ".cache")
            self.assertEqual(file_for_streaming(str(target)), str(target))
            self.assertEqual(file_for_streaming(str(root / ".cache" / ".." / "a.png")), str(target))
            cases = (
                (str(root / "none.png"), "not_found"),
                (str(root / "folder.png"), "not_a_file"),
                ("a.png", "bad_request"),
                (tmp, "not_media"),
                (str(root / "notes.txt"), "not_media"),
                (str(root / ".a.png"), "hidden"),
                (str(root / ".cache" / "b.png"), "hidden"),
                (str(root / "link.png"), "not_media"),
                (str(root / "cachelink" / "b.png"), "hidden"),
            )
            for raw, code in cases:
                with self.assertRaises(FsError) as caught:
                    file_for_streaming(raw)
                self.assertEqual(caught.exception.code, code, raw)


class PlacesTests(unittest.TestCase):
    def test_start_is_comfy_input_and_places_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            dirs = {"input": os.path.join(tmp, "in"), "output": os.path.join(tmp, "out"), "temp": os.path.join(tmp, "tmp")}
            result = places(dirs)
            self.assertEqual(result["start"], dirs["input"])
            self.assertEqual(result["comfy"], dirs)
            self.assertEqual(result["places"][0], {"label": "Home", "path": str(Path.home())})
            self.assertTrue(all(os.path.isdir(place["path"]) for place in result["places"]))
            self.assertIn("png", result["kinds"]["image"])


if __name__ == "__main__":
    unittest.main()
