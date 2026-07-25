"""Route tests using an in-process aiohttp server (no ComfyUI needed)."""

import json
import unittest

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

from comfyui.ae_bridge import job_store, routes


def make_client(loop):
    app = web.Application()
    assert routes.register_handlers(app.router) is True
    return TestClient(TestServer(app))


class RouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for j in job_store.list_jobs():
            job_store.cleanup_job(j["job_id"])

    def tearDown(self):
        for j in job_store.list_jobs():
            job_store.cleanup_job(j["job_id"])

    async def test_health(self):
        async with make_client(None) as client:
            resp = await client.get("/ae_bridge/health")
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertTrue(data["ok"])
            self.assertEqual(data["app"], "ae2comfyui")

    async def test_upload_and_get_job(self):
        async with make_client(None) as client:
            form = FormData()
            form.add_field("job_id", "job-r1")
            form.add_field("asset_id", "main")
            form.add_field("metadata", json.dumps({"width": 8, "height": 4}))
            form.add_field("file", b"png-bytes", filename="main.png",
                           content_type="image/png")
            resp = await client.post("/ae_bridge/assets", data=form)
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertTrue(data["ok"])
            self.assertTrue(data["path"].endswith("main.png"))

            resp = await client.get("/ae_bridge/jobs/job-r1")
            self.assertEqual(resp.status, 200)
            job = await resp.json()
            self.assertEqual(job["metadata"]["width"], 8)
            self.assertEqual(job["assets"], {"main": "main.png"})
            self.assertIsNone(job["result"])

    async def test_upload_bad_asset_id(self):
        async with make_client(None) as client:
            form = FormData()
            form.add_field("job_id", "job-r2")
            form.add_field("asset_id", "../../etc")
            form.add_field("metadata", "{}")
            form.add_field("file", b"x", filename="main.png")
            resp = await client.post("/ae_bridge/assets", data=form)
            self.assertEqual(resp.status, 400)

    async def test_upload_bad_metadata(self):
        async with make_client(None) as client:
            form = FormData()
            form.add_field("job_id", "job-r3")
            form.add_field("asset_id", "main")
            form.add_field("metadata", "not-json{")
            form.add_field("file", b"x", filename="main.png")
            resp = await client.post("/ae_bridge/assets", data=form)
            self.assertEqual(resp.status, 400)

    async def test_get_job_unknown(self):
        async with make_client(None) as client:
            resp = await client.get("/ae_bridge/jobs/nope")
            self.assertEqual(resp.status, 404)

    async def test_result_not_ready_then_ready(self):
        async with make_client(None) as client:
            form = FormData()
            form.add_field("job_id", "job-r4")
            form.add_field("asset_id", "main")
            form.add_field("metadata", "{}")
            form.add_field("file", b"img", filename="main.png")
            await client.post("/ae_bridge/assets", data=form)

            resp = await client.get("/ae_bridge/jobs/job-r4/result")
            self.assertEqual(resp.status, 404)

            path = job_store.get_asset("job-r4", "main")
            job_store.set_result(
                "job-r4", path, {"format": "png", "width": 8, "height": 4}
            )
            resp = await client.get("/ae_bridge/jobs/job-r4/result")
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["X-AEBridge-Format"], "png")
            self.assertEqual(resp.headers["X-AEBridge-Width"], "8")
            body = await resp.read()
            self.assertEqual(body, b"img")

    async def test_multipart_file_before_fields(self):
        """Fields may arrive in any order; file streams to a temp file first."""
        async with make_client(None) as client:
            form = FormData()
            form.add_field("file", b"video-bytes", filename="clip.mov",
                           content_type="video/quicktime")
            form.add_field("job_id", "job-r5")
            form.add_field("asset_id", "main")
            form.add_field("metadata", "{}")
            resp = await client.post("/ae_bridge/assets", data=form)
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertTrue(data["path"].endswith("main.mov"))


if __name__ == "__main__":
    unittest.main()
