import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # ComfyUI root, for comfy_api

from aala_media.nodes.list_splitter import DEFAULT_SLOTS, MAX_SLOTS, ListSplitter


def run(items, slots):
    return ListSplitter.execute(items=items, slots=[slots]).args


class ListSplitterTests(unittest.TestCase):
    def test_schema(self):
        schema = ListSplitter.GET_SCHEMA()
        self.assertEqual((schema.node_id, schema.category), ("AalaListSplitter", "AALA Nodes/utils"))
        self.assertTrue(schema.is_input_list)
        self.assertEqual(len(schema.outputs), MAX_SLOTS)
        self.assertFalse(any(output.is_output_list for output in schema.outputs))
        info = ListSplitter.GET_NODE_INFO_V1()
        self.assertEqual(info["input"]["required"]["slots"][1]["default"], DEFAULT_SLOTS)

    def test_items_map_to_slots_in_order(self):
        outputs = run(["a", "b", "c"], 3)
        self.assertEqual(len(outputs), MAX_SLOTS)
        self.assertEqual(outputs[:3], ("a", "b", "c"))
        self.assertTrue(all(value is None for value in outputs[3:]))

    def test_fewer_items_than_slots_pad_with_none(self):
        self.assertEqual(run(["a"], 3)[:3], ("a", None, None))

    def test_empty_and_none_input_never_raise(self):
        self.assertTrue(all(value is None for value in run([], 9)))
        self.assertTrue(all(value is None for value in ListSplitter.execute(items=None, slots=None).args))
        self.assertEqual(run([None, "b"], 2)[:2], (None, "b"))

    def test_more_items_than_slots_drops_extra_with_warning(self):
        with self.assertLogs(level="WARNING") as logs:
            outputs = run(["a", "b", "c"], 2)
        self.assertEqual(outputs[:3], ("a", "b", None))
        self.assertIn("3 items for 2 slots", logs.output[0])

    def test_slot_count_is_clamped(self):
        self.assertEqual(run(["a", "b"], 0)[:2], ("a", None))
        self.assertEqual(len(run(list(range(500)), 1000)), MAX_SLOTS)


if __name__ == "__main__":
    unittest.main()
