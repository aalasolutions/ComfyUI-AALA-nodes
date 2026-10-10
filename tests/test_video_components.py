import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # ComfyUI root, for comfy_api

from comfy_api.latest import InputImpl
from comfy_execution.graph_utils import ExecutionBlocker

from aala_media.nodes.video_components import GetVideoComponents
from media_fixtures import make_video


class GetVideoComponentsTests(unittest.TestCase):
    def test_schema(self):
        schema = GetVideoComponents.GET_SCHEMA()
        self.assertEqual((schema.node_id, schema.category), ("AalaGetVideoComponents", "AALA Nodes/media"))
        self.assertIn("video", GetVideoComponents.GET_NODE_INFO_V1()["input"]["optional"])

    def test_empty_input_outputs_none(self):
        self.assertEqual(GetVideoComponents.execute(video=None).args, (None, None, None, None, None))

    def test_empty_input_can_skip_downstream(self):
        outputs = GetVideoComponents.execute(video=None, if_empty="skip downstream").args
        self.assertEqual(len(outputs), 5)
        self.assertTrue(all(isinstance(value, ExecutionBlocker) and value.message is None for value in outputs))

    def test_video_components(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_video(Path(tmp) / "clip.mp4", frames=12)
            images, audio, fps, _, _ = GetVideoComponents.execute(video=InputImpl.VideoFromFile(str(path))).args
            self.assertEqual(images.shape[0], 12)
            self.assertIsNotNone(audio)
            self.assertAlmostEqual(fps, 24000 / 1001, places=3)


if __name__ == "__main__":
    unittest.main()
