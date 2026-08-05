"""End-to-end server-side integration: upload → FromAE → ToAE → download.

Simulates exactly what the AE panel and a ComfyUI workflow do, without
needing a running ComfyUI: aiohttp routes + job store + nodes + image I/O.
"""

import json
import unittest

import pytest

torch = pytest.importorskip("torch")

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer

from comfyui.ae_bridge import image_io, job_store, routes
from comfyui.ae_bridge.nodes import FromAE, ToAE


def make_client():
    app = web.Application()
    assert routes.register_handlers(app.router) is True
    return TestClient(TestServer(app))


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for j in job_store.list_jobs():
            job_store.cleanup_job(j["job_id"])

    def tearDown(self):
        for j in job_store.list_jobs():
            job_store.cleanup_job(j["job_id"])

    async def test_image_roundtrip_through_http_and_nodes(self):
        manifest = {
            "job_id": "job-e2e", "media_type": "image",
            "width": 8, "height": 4, "prompt": "make it glow",
            "mask_mode": "use", "bridge_color_mode": "preserve_working_space",
        }
        source = torch.rand((1, 4, 8, 3), dtype=torch.float32)
        mask = torch.zeros((1, 4, 8), dtype=torch.float32)
        mask[0, :, :4] = 1.0
        png, _, _ = image_io.encode_image_bytes(source, "png")
        mask_rgb = mask.unsqueeze(-1).repeat(1, 1, 1, 3)
        mask_png, _, _ = image_io.encode_image_bytes(mask_rgb, "png")

        async with make_client() as client:
            # 1. Panel uploads the rendered still + manifest.
            form = FormData()
            form.add_field("job_id", "job-e2e")
            form.add_field("asset_id", "main")
            form.add_field("metadata", json.dumps(manifest))
            form.add_field("file", png, filename="main.png", content_type="image/png")
            resp = await client.post("/ae_bridge/assets", data=form)
            self.assertEqual(resp.status, 200)

            mask_form = FormData()
            mask_form.add_field("job_id", "job-e2e")
            mask_form.add_field("asset_id", "mask")
            mask_form.add_field("metadata", json.dumps(manifest))
            mask_form.add_field(
                "file", mask_png, filename="mask.png", content_type="image/png"
            )
            resp = await client.post("/ae_bridge/assets", data=mask_form)
            self.assertEqual(resp.status, 200)

            # 2. Workflow executes FromAE -> (process) -> ToAE.
            image, out_mask, prompt, w, h = FromAE().pull("job-e2e", "main")
            self.assertEqual(prompt, "make it glow")
            self.assertEqual((w, h), (8, 4))
            processed = 1.0 - image  # stand-in for a real diffusion pass
            ToAE().push(processed, "job-e2e", "ae_result", "png", mask=out_mask)

            # 3. Panel downloads the result.
            resp = await client.get("/ae_bridge/jobs/job-e2e/result")
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["X-AEBridge-Format"], "png")
            self.assertEqual(resp.headers["X-AEBridge-Width"], "8")
            body = await resp.read()

        decoded, result_mask, w, h = image_io.decode_image_bytes(body, "png")
        assert torch.allclose(decoded, processed, atol=2 / 255.0)
        assert float(result_mask[0, 0, 0]) > 0.9  # mask survived the round trip
        assert float(result_mask[0, 0, -1]) < 0.1


if __name__ == "__main__":
    unittest.main()
