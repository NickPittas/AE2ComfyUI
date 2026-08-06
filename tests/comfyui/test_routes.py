"""Route tests using an in-process aiohttp server (no ComfyUI needed)."""

import json
import os
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
            self.assertEqual(resp.headers["Access-Control-Allow-Origin"], "*")
            data = await resp.json()
            self.assertTrue(data["ok"])
            self.assertEqual(data["app"], "ae2comfyui")
            self.assertIn("job_store", data)
            self.assertTrue(data["job_store"]["module"])

    async def test_cors_exposes_result_headers(self):
        async with make_client(None) as client:
            resp = await client.options("/ae_bridge/jobs/x/result")
            self.assertEqual(resp.status, 200)
            allow = resp.headers["Access-Control-Allow-Headers"]
            self.assertIn("Range", allow)
            expose = resp.headers["Access-Control-Expose-Headers"]
            self.assertIn("X-AEBridge-Format", expose)
            self.assertIn("Content-Range", expose)

    async def test_options_preflight(self):
        async with make_client(None) as client:
            resp = await client.options("/ae_bridge/assets")
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["Access-Control-Allow-Origin"], "*")
            self.assertIn("POST", resp.headers["Access-Control-Allow-Methods"])

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

    # --- chunked upload -----------------------------------------------------

    def _random_bytes(self, n):
        import hashlib, os
        # Deterministic-ish but covers 0x00 and 0xFF runs.
        out = bytearray()
        seed = 0
        for i in range(n):
            seed = (seed * 31 + i * 7 + 1) % 251
            out.append(seed)
        return bytes(out)

    async def _chunked_upload(self, client, job_id, asset_id, data, size=None,
                              filename="main.mov"):
        resp = await client.post("/ae_bridge/assets/begin", json={
            "job_id": job_id, "asset_id": asset_id, "filename": filename,
            "size": size if size is not None else len(data),
            "metadata": {"width": 64, "height": 64, "fps": 24},
        })
        self.assertEqual(resp.status, 200, await resp.text())
        step = 7  # deliberately awkward chunk boundaries
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + step]
            resp = await client.post(
                f"/ae_bridge/assets/chunk?job_id={job_id}&asset_id={asset_id}"
                f"&offset={offset}",
                data=chunk, headers={"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(resp.status, 200, await resp.text())
            offset += len(chunk)
        resp = await client.post("/ae_bridge/assets/finish", json={
            "job_id": job_id, "asset_id": asset_id, "size": len(data),
        })
        self.assertEqual(resp.status, 200, await resp.text())
        return await resp.json()

    async def test_chunked_upload_roundtrip_hash_equality(self):
        import hashlib
        async with make_client(None) as client:
            data = bytes((i & 0xFF) for i in range(256)) * 400  # incl 0x00/0xFF
            out = await self._chunked_upload(client, "job-c1", "main", data)
            self.assertTrue(out["path"].endswith("main.mov"))
            path = job_store.get_asset("job-c1", "main")
            with open(path, "rb") as fh:
                got = fh.read()
            self.assertEqual(hashlib.sha256(got).hexdigest(),
                             hashlib.sha256(data).hexdigest())
            self.assertEqual(len(got), len(data))
            # Asset is registered for the panel's GET /jobs check.
            resp = await client.get("/ae_bridge/jobs/job-c1")
            self.assertEqual(resp.status, 200)
            job = await resp.json()
            self.assertEqual(job["assets"], {"main": "main.mov"})

    async def test_chunked_upload_offset_writes(self):
        async with make_client(None) as client:
            data = self._random_bytes(1000)
            # begin, then two writes at 0 and 500 to prove seek-offset writes.
            resp = await client.post("/ae_bridge/assets/begin", json={
                "job_id": "job-c2", "asset_id": "main",
                "filename": "main.mov", "size": len(data),
                "metadata": {},
            })
            self.assertEqual(resp.status, 200)
            for offset in (0, 500):
                resp = await client.post(
                    f"/ae_bridge/assets/chunk?job_id=job-c2&asset_id=main&offset={offset}",
                    data=data[offset:offset + 500],
                    headers={"Content-Type": "application/octet-stream"},
                )
                self.assertEqual(resp.status, 200)
            resp = await client.post("/ae_bridge/assets/finish", json={
                "job_id": "job-c2", "asset_id": "main", "size": len(data),
            })
            self.assertEqual(resp.status, 200)
            with open(job_store.get_asset("job-c2", "main"), "rb") as fh:
                self.assertEqual(fh.read(), data)

    async def test_chunk_without_begin_rejected(self):
        async with make_client(None) as client:
            resp = await client.post(
                "/ae_bridge/assets/chunk?job_id=job-c3&asset_id=main&offset=0",
                data=b"abc",
            )
            self.assertEqual(resp.status, 400)
            self.assertIn("begin", (await resp.json())["error"])

    async def test_chunked_finish_size_mismatch_rejected(self):
        async with make_client(None) as client:
            resp = await client.post("/ae_bridge/assets/begin", json={
                "job_id": "job-c4", "asset_id": "main",
                "filename": "main.mov", "size": 100, "metadata": {},
            })
            self.assertEqual(resp.status, 200)
            resp = await client.post(
                "/ae_bridge/assets/chunk?job_id=job-c4&asset_id=main&offset=0",
                data=b"x" * 50,
            )
            self.assertEqual(resp.status, 200)
            resp = await client.post("/ae_bridge/assets/finish", json={
                "job_id": "job-c4", "asset_id": "main", "size": 100,
            })
            self.assertEqual(resp.status, 400)
            error = (await resp.json())["error"]
            self.assertIn("verification failed", error)
            self.assertIn("written 50", error)
            # Nothing was registered.
            with self.assertRaises(KeyError):
                job_store.get_asset("job-c4", "main")

    async def test_chunked_finish_sparse_ranges_rejected(self):
        async with make_client(None) as client:
            resp = await client.post("/ae_bridge/assets/begin", json={
                "job_id": "job-c5", "asset_id": "main",
                "filename": "main.mov", "size": 1000, "metadata": {},
            })
            self.assertEqual(resp.status, 200)
            resp = await client.post(
                "/ae_bridge/assets/chunk?job_id=job-c5&asset_id=main&offset=500",
                data=b"x" * 500,
            )
            self.assertEqual(resp.status, 200)
            resp = await client.post("/ae_bridge/assets/finish", json={
                "job_id": "job-c5", "asset_id": "main", "size": 1000,
            })
            self.assertEqual(resp.status, 400)
            error = (await resp.json())["error"]
            self.assertIn("verification failed", error)
            self.assertIn("ranges", error)

    async def test_chunk_over_limit_rejected(self):
        async with make_client(None) as client:
            resp = await client.post("/ae_bridge/assets/begin", json={
                "job_id": "job-c6", "asset_id": "main",
                "filename": "main.mov", "size": 9, "metadata": {},
            })
            self.assertEqual(resp.status, 200)
            original_limit = routes.MAX_CHUNK_BYTES
            routes.MAX_CHUNK_BYTES = 8
            try:
                resp = await client.post(
                    "/ae_bridge/assets/chunk?job_id=job-c6&asset_id=main&offset=0",
                    data=b"x" * 9,
                )
            finally:
                routes.MAX_CHUNK_BYTES = original_limit
            self.assertEqual(resp.status, 413)
            self.assertIn("limit", (await resp.json())["error"])

    async def test_range_result_download(self):
        async with make_client(None) as client:
            data = self._random_bytes(4096)
            path = job_store.job_dir("job-r6") + "/res.mov"
            os.makedirs(job_store.job_dir("job-r6"), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(data)
            job_store.create_job("job-r6", {})
            job_store.set_result(
                "job-r6", path,
                {"format": "mov", "width": 64, "height": 64,
                 "frame_count": 8, "fps": 24.0, "duration_seconds": 0.3333},
            )
            resp = await client.get(
                "/ae_bridge/jobs/job-r6/result", headers={"Range": "bytes=100-199"}
            )
            self.assertEqual(resp.status, 206)
            self.assertEqual(resp.headers["Content-Range"], "bytes 100-199/4096")
            self.assertEqual(resp.headers["X-AEBridge-Format"], "mov")
            self.assertEqual(resp.headers["X-AEBridge-Frame-Count"], "8")
            self.assertEqual(await resp.read(), data[100:200])

            # Tail range.
            resp = await client.get(
                "/ae_bridge/jobs/job-r6/result", headers={"Range": "bytes=-100"}
            )
            self.assertEqual(resp.status, 206)
            self.assertEqual(await resp.read(), data[-100:])

            # Full download still works without a Range header.
            resp = await client.get("/ae_bridge/jobs/job-r6/result")
            self.assertEqual(resp.status, 200)
            self.assertEqual(await resp.read(), data)
            self.assertEqual(resp.headers["X-AEBridge-Duration"], "0.3333")


if __name__ == "__main__":
    unittest.main()
