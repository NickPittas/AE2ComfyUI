"""Video I/O round-trip tests (requires ffmpeg/ffprobe on PATH)."""

import shutil

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from comfyui.ae_bridge import video_io

ffmpeg_missing = shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None
pytestmark = pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg/ffprobe not installed")

W, H, FRAMES, FPS = 64, 64, 8, 24.0


def make_frames():
    x = torch.linspace(0, 1, W)
    base = x.expand(H, W).unsqueeze(0).unsqueeze(-1).repeat(FRAMES, 1, 1, 3)
    steps = torch.linspace(0, 0.5, FRAMES)[:, None, None, None]
    return (base * 0.5 + steps).clamp(0, 1).float()


def make_mask():
    mask = torch.zeros((FRAMES, H, W), dtype=torch.float32)
    mask[:, :, : W // 2] = 1.0
    return mask


def test_mov_prores_roundtrip(tmp_path):
    frames = make_frames()
    path = str(tmp_path / "main.mov")
    video_io.encode_video(frames, path, "mov", "prores_4444", FPS)
    probe = video_io.probe_video(path)
    assert (probe["width"], probe["height"]) == (W, H)
    assert probe["nb_frames"] == FRAMES
    assert abs(probe["fps"] - FPS) < 0.01

    image, mask, w, h, count = video_io.decode_video(path)
    assert (w, h, count) == (W, H, FRAMES)
    assert image.shape == (FRAMES, H, W, 3)
    assert mask.shape == (FRAMES, H, W)
    assert float(mask.max()) == 0.0  # no mask file -> all keep
    # ProRes 10-bit 4:4:4:4 from rgb48le should be close to source
    assert torch.allclose(image, frames, atol=0.02)


def test_mp4_roundtrip_with_mask(tmp_path):
    frames = make_frames()
    main = str(tmp_path / "main.mp4")
    maskp = str(tmp_path / "mask.mp4")
    video_io.encode_video(frames, main, "mp4", "", FPS)
    video_io.encode_mask_video(make_mask(), maskp, FPS)

    image, mask, w, h, count = video_io.decode_video(main, maskp, expected_frames=FRAMES)
    assert (w, h, count) == (W, H, FRAMES)
    assert float(mask[0, 0, 0]) > 0.8  # masked half
    assert float(mask[0, 0, -1]) < 0.2  # keep half


def test_expected_frames_mismatch_raises(tmp_path):
    frames = make_frames()
    main = str(tmp_path / "main.mp4")
    video_io.encode_video(frames, main, "mp4", "", FPS)
    with pytest.raises(RuntimeError, match="undershoot"):
        video_io.decode_video(main, expected_frames=FRAMES + 4)


def test_mask_geometry_mismatch_raises(tmp_path):
    frames = make_frames()
    main = str(tmp_path / "main.mp4")
    small = str(tmp_path / "small.mp4")
    video_io.encode_video(frames, main, "mp4", "", FPS)
    video_io.encode_video(frames[:, :32, :32, :], small, "mp4", "", FPS)
    with pytest.raises(RuntimeError, match="geometry"):
        video_io.decode_video(main, small)


def test_color_tags_written(tmp_path):
    frames = make_frames()
    path = str(tmp_path / "tagged.mov")
    video_io.encode_video(frames, path, "mov", "prores_422hq", FPS,
                          source_meta={"color_range": "tv"})
    meta = video_io.probe_source_meta(path)
    assert meta.get("color_primaries") == "bt709"
    assert meta.get("color_trc") == "bt709"
    assert meta.get("colorspace") == "bt709"
    assert meta.get("color_range") == "tv"


def test_encode_mask_video_shape_handling(tmp_path):
    mask = make_mask()
    path = str(tmp_path / "m.mp4")
    video_io.encode_mask_video(mask, path, FPS)
    probe = video_io.probe_video(path)
    assert probe["nb_frames"] == FRAMES
    assert (probe["width"], probe["height"]) == (W, H)
