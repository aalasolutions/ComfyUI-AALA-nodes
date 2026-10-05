import json
import unittest

from aala_media.state import (
    DEFAULT_LIMIT,
    KINDS,
    SCHEMA_ID,
    SCHEMA_VERSION,
    MediaStateError,
    default_state,
    default_state_json,
    parse_state,
)


def _state(**overrides):
    state = default_state()
    state.update(overrides)
    return json.dumps(state)


class ParseStateTests(unittest.TestCase):
    def test_default_round_trip(self):
        self.assertEqual(parse_state(default_state_json()), default_state())

    def test_empty_value_returns_default(self):
        self.assertEqual(parse_state(""), default_state())
        self.assertEqual(parse_state(None), default_state())

    def test_default_limits(self):
        self.assertEqual(default_state()["limits"], {kind: DEFAULT_LIMIT for kind in KINDS})

    def test_invalid_json(self):
        with self.assertRaises(MediaStateError):
            parse_state("{not json")

    def test_wrong_schema(self):
        with self.assertRaises(MediaStateError):
            parse_state(_state(schema="other"))

    def test_newer_version_rejected(self):
        with self.assertRaisesRegex(MediaStateError, "newer"):
            parse_state(_state(version=SCHEMA_VERSION + 1))

    def test_negative_limit_rejected(self):
        with self.assertRaises(MediaStateError):
            parse_state(_state(limits={"image": -1, "video": 9, "audio": 9}))

    def test_item_in_wrong_group_rejected(self):
        groups = {"image": [{"path": "/a.mp4", "kind": "video", "active": True}], "video": [], "audio": []}
        with self.assertRaises(MediaStateError):
            parse_state(_state(groups=groups))

    def test_active_over_limit_reports_limit_full(self):
        items = [{"path": f"/{index}.png", "kind": "image", "active": True} for index in range(3)]
        groups = {"image": items, "video": [], "audio": []}
        with self.assertRaisesRegex(MediaStateError, "limit 2 is full"):
            parse_state(_state(limits={"image": 2, "video": 9, "audio": 9}, groups=groups))

    def test_inactive_items_do_not_count_against_limit(self):
        items = [{"path": f"/{index}.png", "kind": "image", "active": index == 0} for index in range(5)]
        groups = {"image": items, "video": [], "audio": []}
        state = parse_state(_state(limits={"image": 1, "video": 9, "audio": 9}, groups=groups))
        self.assertEqual(len(state["groups"]["image"]), 5)
        self.assertEqual(state["schema"], SCHEMA_ID)


def _ui_item(kind, **fields):
    # Shape written by frontend/src/state/items.ts createItem.
    item = {"id": f"id-{kind}", "path": f"/media/file.{kind}", "kind": kind, "active": True}
    if kind != "image":
        item["muted"] = False
    item["meta"] = None
    item["edit"] = {}
    if kind == "video":
        item.update({"split_of": None, "part": None, "parts": None})
    item.update(fields)
    return item


def _with(kind, item):
    groups = {"image": [], "video": [], "audio": []}
    groups[kind] = [item]
    return _state(groups=groups)


class ItemValidationTests(unittest.TestCase):
    def assertRejected(self, kind, pattern, **fields):
        with self.assertRaisesRegex(MediaStateError, pattern):
            parse_state(_with(kind, _ui_item(kind, **fields)))

    def test_ui_written_items_accepted(self):
        groups = {kind: [_ui_item(kind)] for kind in KINDS}
        state = parse_state(_state(groups=groups))
        self.assertEqual(state["groups"]["video"][0]["parts"], None)

    def test_full_edits_accepted(self):
        crop = {"x": 0.1, "y": 0.0, "w": 0.8, "h": 1.0}
        parse_state(_with("image", _ui_item("image", edit={"crop": crop, "rotate": 270, "mirror": True})))
        video_edit = {"crop": None, "rotate": 90, "mirror": False, "trim": {"start_frame": 0, "end_frame": 24}}
        parse_state(_with("video", _ui_item("video", edit=video_edit, split_of="orig", part=2, parts=4, meta={"fps": "30000/1001"})))
        parse_state(_with("audio", _ui_item("audio", edit={"trim": {"start": 0.5, "end": 1.25}})))

    def test_inapplicable_fields_rejected(self):
        self.assertRejected("image", "muted does not apply", muted=False)
        self.assertRejected("audio", "split_of does not apply", split_of=None)
        self.assertRejected("image", "trim does not apply", edit={"trim": {"start": 0, "end": 1}})
        self.assertRejected("audio", "crop does not apply", edit={"crop": None})
        self.assertRejected("audio", "rotate does not apply", edit={"rotate": 0})

    def test_field_types(self):
        self.assertRejected("image", "meta", meta="big")
        self.assertRejected("image", "edit must be", edit=[])
        self.assertRejected("video", "active", active="yes")
        self.assertRejected("video", "muted", muted=1)

    def test_crop_rules(self):
        self.assertRejected("image", "within", edit={"crop": {"x": 0.5, "y": 0, "w": 0.6, "h": 1}})
        self.assertRejected("image", "crop must be", edit={"crop": {"x": 0, "y": 0, "w": 1}})
        self.assertRejected("image", "within", edit={"crop": {"x": 0, "y": 0, "w": 0, "h": 1}})

    def test_rotate_and_mirror_rules(self):
        self.assertRejected("image", "rotate", edit={"rotate": 45})
        self.assertRejected("video", "rotate", edit={"rotate": False})
        self.assertRejected("video", "mirror", edit={"mirror": 1})

    def test_trim_rules(self):
        self.assertRejected("video", "integer frames", edit={"trim": {"start_frame": 5, "end_frame": 5}})
        self.assertRejected("video", "integer frames", edit={"trim": {"start_frame": 0.5, "end_frame": 5}})
        self.assertRejected("video", "start_frame, end_frame", edit={"trim": {"start": 0, "end": 1}})
        self.assertRejected("audio", "seconds", edit={"trim": {"start": 2, "end": 1}})

    def test_split_rules(self):
        self.assertRejected("video", "split_of", split_of="orig", part=None, parts=None)
        self.assertRejected("video", "split_of", split_of="orig", part=5, parts=4)


if __name__ == "__main__":
    unittest.main()
