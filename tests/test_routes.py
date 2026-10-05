import asyncio
import tempfile
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from aala_media.server.routes import create_routes
from aala_media.server.thumbs import MediaCache
from media_fixtures import make_image, make_video


class RoutesTests(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.image = make_image(self.root / "a.png")
        self.dirs = {"input": str(self.root), "output": str(self.root), "temp": str(self.root)}
        app = web.Application()
        self.cache = MediaCache(self.root / "cache")
        app.add_routes(create_routes(lambda: self.dirs, self.cache))
        return app

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def test_places_starts_at_input(self):
        response = await self.client.get("/aala-media/fs/places")
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["start"], str(self.root))

    async def test_list_and_errors(self):
        response = await self.client.get("/aala-media/fs/list", params={"path": str(self.root)})
        self.assertEqual([entry["name"] for entry in (await response.json())["entries"]], ["a.png"])
        cases = [
            ({"path": str(self.root / "missing")}, 404, "not_found"),
            ({"path": str(self.image)}, 400, "not_a_directory"),
            ({}, 400, "bad_request"),
        ]
        for params, status, code in cases:
            response = await self.client.get("/aala-media/fs/list", params=params)
            self.assertEqual(response.status, status, params)
            self.assertEqual((await response.json())["error"], code)

    async def test_probe_validation(self):
        response = await self.client.post("/aala-media/fs/probe", json={"paths": [str(self.image)]})
        self.assertEqual((await response.json())[str(self.image)]["width"], 40)
        for body in ({"paths": "x"}, {"paths": [1]}, ["x"], {"paths": ["/a"] * 501}):
            response = await self.client.post("/aala-media/fs/probe", json=body)
            self.assertEqual(response.status, 400, body)
        response = await self.client.post("/aala-media/fs/probe", data="not json")
        self.assertEqual(response.status, 400)

    async def test_file_streaming_supports_range(self):
        data = self.image.read_bytes()
        response = await self.client.get("/aala-media/fs/file", params={"path": str(self.image)})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "image/png")
        self.assertEqual(await response.read(), data)
        response = await self.client.get(
            "/aala-media/fs/file", params={"path": str(self.image)}, headers={"Range": "bytes=0-9"}
        )
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), data[:10])
        response = await self.client.get("/aala-media/fs/file", params={"path": str(self.root / "none.png")})
        self.assertEqual(response.status, 404)

    async def test_thumb_frame_peaks_endpoints(self):
        video = make_video(self.root / "clip.mp4")
        response = await self.client.get("/aala-media/fs/thumb", params={"path": str(self.image), "size": "256"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "image/webp")
        self.assertIn("immutable", response.headers["Cache-Control"])
        response = await self.client.get("/aala-media/fs/frame", params={"path": str(video), "t": "0.2"})
        self.assertEqual(response.status, 200)
        response = await self.client.get("/aala-media/fs/peaks", params={"path": str(video), "buckets": "32"})
        self.assertEqual(len((await response.json())["peaks"]), 64)
        for url, params, status in (
            ("/aala-media/fs/thumb", {"path": str(self.root / "none.png")}, 404),
            ("/aala-media/fs/thumb", {"path": str(self.image), "size": "abc"}, 400),
            ("/aala-media/fs/frame", {"path": str(video), "t": "nan"}, 400),
            ("/aala-media/fs/frame", {"path": str(video), "t": "1e300"}, 400),
            ("/aala-media/fs/peaks", {"path": str(self.image)}, 400),
        ):
            response = await self.client.get(url, params=params)
            self.assertEqual(response.status, status, (url, params))

    async def test_concurrent_thumb_requests_render_once(self):
        calls = []
        original = self.cache.thumb

        def counting(path, size):
            calls.append(path)
            return original(path, size)

        self.cache.thumb = counting
        params = {"path": str(self.image), "size": "128"}
        responses = await asyncio.gather(*(self.client.get("/aala-media/fs/thumb", params=params) for _ in range(5)))
        self.assertEqual([response.status for response in responses], [200] * 5)
        self.assertEqual(len(calls), 1)

    async def test_cancelled_leader_does_not_fail_followers(self):
        from aala_media.server import routes

        started = asyncio.Event()

        def slow():
            import time

            time.sleep(0.2)
            return "done"

        async def leader():
            started.set()
            return await routes._run_shared(("test", 1), slow)

        leader_task = asyncio.ensure_future(leader())
        await started.wait()
        await asyncio.sleep(0)
        follower = asyncio.ensure_future(routes._run_shared(("test", 1), slow))
        await asyncio.sleep(0.01)
        leader_task.cancel()
        self.assertEqual(await follower, "done")
        self.assertNotIn(("test", 1), routes._inflight)


if __name__ == "__main__":
    unittest.main()
