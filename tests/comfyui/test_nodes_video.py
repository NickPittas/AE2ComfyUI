"""Node-level tests for FromAEVideo/ToAEVideo (requires ffmpeg)."""

import json
import shutil

import pytest

torch = pytest.importorskip("torch")

from comfyui.ae_bridge import job_store, video_io
from comfyui.ae_bridge.nodes import FromAEVideo, ToAEVideo

ffmpeg_missing = shutil.which("ffmpeg") is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg not installed")

W, H, FRAMES, FPS = 64, 64, 8, 24.0


@pytest.fixture(autouse=True)
def clean_jobs():
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])
    yield
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])


def make_frames():
    return torch.rand((FRAMES, H, W, 3), dtype=torch.float32)


def seed_video_job(job_id="job-v1", with_mask=True):
    frames = make_frames()
    d = job_store.job_dir(job_id)
    main_path = d + "/main.mov"
    meta = {
        "media_type": "video", "width": W, "height": H,
        "fps": FPS, "frame_count": FRAMES,
        "duration_seconds": FRAMES / FPS,
        "mask_mode": "use" if with_mask else "none",
        "video_format": "mov", "mov_codec": "prores_4444",
        "prompt": "make it neon",
    }
    job_store.create_job(job_id, meta)
    video_io.encode_video(frames, main_path, "mov", "prores_4444", FPS)
    job_store.store_asset(job_id, "main", main_path)
    if with_mask:
        mask = torch.zeros((FRAMES, H, W), dtype=torch.float32)
        mask[:, :, : W // 2] = 1.0
        mask_path = d + "/mask.mp4"
        video_io.encode_mask_video(mask, mask_path, FPS)
        job_store.store_asset(job_id, "mask", mask_path)
    return frames


def test_from_ae_video_outputs_full_metadata():
    seed_video_job()
    image, mask, w, h, count, fps, duration, meta_json = FromAEVideo().pull("job-v1", "main")
    assert image.shape == (FRAMES, H, W, 3)
    assert mask.shape == (FRAMES, H, W)
    assert (w, h, count) == (W, H, FRAMES)
    assert fps == pytest.approx(FPS)
    assert duration == pytest.approx(FRAMES / FPS)
    meta = json.loads(meta_json)
    assert meta["prompt"] == "make it neon"
    assert meta["frame_count"] == FRAMES


def test_from_ae_video_mask_values():
    seed_video_job(with_mask=True)
    _, mask, _, _, _, _, _, _ = FromAEVideo().pull("job-v1", "main")
    assert float(mask[0, 0, 0]) > 0.8
    assert float(mask[0, 0, -1]) < 0.2


def test_from_ae_video_no_mask_mode_returns_all_keep():
    seed_video_job(with_mask=False)
    _, mask, _, _, count, _, _, _ = FromAEVideo().pull("job-v1", "main")
    assert mask.shape == (count, H, W)
    assert float(mask.max()) == 0.0


def test_from_ae_video_empty_job_id_raises():
    with pytest.raises(RuntimeError, match="job_id"):
        FromAEVideo().pull("", "main")


def test_to_ae_video_writes_mov_result():
    seed_video_job()
    out_frames = make_frames()
    ToAEVideo().push(out_frames, "job-v1", "{}", "res", "auto", "auto")
    result = job_store.get_result("job-v1")
    assert result is not None
    assert result["path"].endswith("res.mov")
    meta = result["metadata"]
    assert meta["format"] == "mov"
    assert meta["frame_count"] == FRAMES
    assert meta["fps"] == FPS
    assert meta["duration_seconds"] == pytest.approx(FRAMES / FPS)
    probe = video_io.probe_video(result["path"])
    assert probe["nb_frames"] == FRAMES


def test_to_ae_video_mask_writes_sidecar_mp4():
    seed_video_job()
    out_frames = make_frames()
    mask = torch.zeros((FRAMES, H, W), dtype=torch.float32)
    mask[:, :, : W // 2] = 1.0
    ToAEVideo().push(out_frames, "job-v1", "{}", "resm", "auto", "auto", mask=mask)
    result = job_store.get_result("job-v1")
    mask_file = result["metadata"].get("mask_file")
    assert mask_file and mask_file.endswith("_mask.mp4")
    probe = video_io.probe_video(mask_file)
    assert probe["nb_frames"] == FRAMES


def test_to_ae_video_meta_json_overrides():
    seed_video_job()
    meta = {"video_format": "mp4", "fps": 30.0}
    ToAEVideo().push(make_frames(), "job-v1", json.dumps(meta), "resx", "auto", "auto")
    result = job_store.get_result("job-v1")
    assert result["path"].endswith(".mp4")
    assert result["metadata"]["fps"] == 30.0
