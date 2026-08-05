"""Node-level tests for FromAE/ToAE against a seeded job store."""

import pytest

torch = pytest.importorskip("torch")

from comfyui.ae_bridge import image_io, job_store
from comfyui.ae_bridge.nodes import FromAE, ToAE


@pytest.fixture(autouse=True)
def clean_jobs():
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])
    yield
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])


def seed_job(job_id="job-n1", prompt="a red cube"):
    image = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    mask = torch.zeros((1, 4, 8), dtype=torch.float32)
    body, _, _ = image_io.encode_image_bytes(image, "png", mask)
    job_store.create_job(job_id, {"prompt": prompt})
    path = job_store.job_dir(job_id) + "/main.png"
    with open(path, "wb") as fh:
        fh.write(body)
    job_store.store_asset(job_id, "main", path)
    return image, mask


def test_from_ae_pulls_image_mask_prompt_geometry():
    seed_job()
    image, mask, prompt, w, h = FromAE().pull("job-n1", "main")
    assert prompt == "a red cube"
    assert (w, h) == (8, 4)
    assert image.shape == (1, 4, 8, 3)
    assert mask.shape == (1, 4, 8)


def test_from_ae_uses_separate_selected_layer_mask():
    from PIL import Image
    import numpy as np

    seed_job(job_id="job-mask")
    job_store.create_job("job-mask", {"prompt": "masked", "mask_mode": "use"})
    arr = np.zeros((4, 8), dtype=np.uint8)
    arr[:, :4] = 255
    path = job_store.job_dir("job-mask") + "/mask.png"
    Image.fromarray(arr, "L").save(path, format="PNG")
    job_store.store_asset("job-mask", "mask", path)

    image, mask, prompt, w, h = FromAE().pull("job-mask", "main")
    assert image.shape == (1, 4, 8, 3)
    assert (w, h) == (8, 4)
    assert prompt == "masked"
    assert float(mask[0, 0, 0]) > 0.99
    assert float(mask[0, 0, -1]) == 0.0


def test_from_ae_rejects_mask_geometry_mismatch():
    from PIL import Image
    import numpy as np

    seed_job(job_id="job-mask-size")
    job_store.create_job("job-mask-size", {"mask_mode": "use"})
    path = job_store.job_dir("job-mask-size") + "/mask.png"
    Image.fromarray(np.zeros((2, 2), dtype=np.uint8), "L").save(path, format="PNG")
    job_store.store_asset("job-mask-size", "mask", path)
    with pytest.raises(RuntimeError, match="mask geometry"):
        FromAE().pull("job-mask-size", "main")


def test_from_ae_empty_job_id_raises():
    with pytest.raises(RuntimeError, match="job_id"):
        FromAE().pull("", "main")


def test_from_ae_unknown_job_raises():
    with pytest.raises(KeyError):
        FromAE().pull("nope", "main")


def test_to_ae_writes_result_and_registers_metadata():
    seed_job()
    result_img = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    out = ToAE().push(result_img, "job-n1", "test_result", "png")
    assert out[0] is result_img
    result = job_store.get_result("job-n1")
    assert result is not None
    assert result["path"].endswith("test_result.png")
    assert result["metadata"] == {"format": "png", "width": 8, "height": 4}
    with open(result["path"], "rb") as fh:
        decoded, _, w, h = image_io.decode_image_bytes(fh.read(), "png")
    assert (w, h) == (8, 4)


def test_to_ae_mask_written_as_alpha():
    seed_job()
    img = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    mask = torch.zeros((1, 4, 8), dtype=torch.float32)
    mask[0, :, :4] = 1.0
    ToAE().push(img, "job-n1", "masked", "png", mask=mask)
    result = job_store.get_result("job-n1")
    with open(result["path"], "rb") as fh:
        _, out_mask, _, _ = image_io.decode_image_bytes(fh.read(), "png")
    assert float(out_mask[0, 0, 0]) > 0.9
    assert float(out_mask[0, 0, -1]) < 0.1


def test_to_ae_jpg_drops_mask():
    seed_job()
    img = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    mask = torch.ones((1, 4, 8), dtype=torch.float32)
    ToAE().push(img, "job-n1", "jpgres", "jpg", mask=mask)
    result = job_store.get_result("job-n1")
    assert result["path"].endswith(".jpg")
    with open(result["path"], "rb") as fh:
        _, out_mask, _, _ = image_io.decode_image_bytes(fh.read(), "jpg")
    assert float(out_mask.max()) == 0.0


def test_to_ae_unique_filenames():
    seed_job()
    img = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    ToAE().push(img, "job-n1", "dup", "png")
    ToAE().push(img, "job-n1", "dup", "png")
    r1 = job_store.get_result("job-n1")["path"]
    assert r1.endswith("dup.001.png")


def test_to_ae_srgb_mode_embeds_icc():
    from PIL import Image
    import io

    image = torch.rand((1, 4, 8, 3), dtype=torch.float32)
    body, _, _ = image_io.encode_image_bytes(image, "png")
    job_store.create_job("job-srgb", {"bridge_color_mode": "srgb"})
    path = job_store.job_dir("job-srgb") + "/main.png"
    with open(path, "wb") as fh:
        fh.write(body)
    job_store.store_asset("job-srgb", "main", path)

    ToAE().push(image, "job-srgb", "icc", "png")
    result = job_store.get_result("job-srgb")
    info = Image.open(result["path"]).info
    if image_io._srgb_icc_bytes() is not None:
        assert info.get("icc_profile")
    else:
        assert not info.get("icc_profile")
