"""Comfy-side video helpers for the AE bridge.

Decode: MOV/MP4 main + optional MP4 mask -> float32 tensors via ffmpeg rawvideo.
Encode: IMAGE batch -> MOV (prores_ks) or MP4 (libx264), with BT.709 fallback
color tags plus tags probed from the source asset.

Env overrides:
  AE_BRIDGE_FFMPEG / AE_BRIDGE_FFPROBE  binary paths
  AE_BRIDGE_VIDEO_RGB_DEPTH             '16' (default, rgb48le) or '8' (rgb24)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Optional, Tuple

import numpy as np
import torch


def _ffmpeg() -> str:
    return os.environ.get("AE_BRIDGE_FFMPEG") or "ffmpeg"


def _ffprobe() -> str:
    return os.environ.get("AE_BRIDGE_FFPROBE") or "ffprobe"


def _rgb_transport() -> tuple[str, np.dtype, int, float]:
    """Main-image rawvideo transport: (pix_fmt, dtype, bytes/sample, scale).

    Mask transport is not parameterized — always gray/uint8/1/255."""
    raw = os.environ.get("AE_BRIDGE_VIDEO_RGB_DEPTH", "16").strip()
    if raw == "16":
        return "rgb48le", np.dtype("<u2"), 2, 65535.0
    if raw == "8":
        return "rgb24", np.dtype(np.uint8), 1, 255.0
    raise RuntimeError(
        f"AE_BRIDGE_VIDEO_RGB_DEPTH must be '8' or '16', got {raw!r}"
    )


_COLOR_WHITELIST = {
    "color_primaries": {"bt709", "bt470bg", "smpte170m", "bt2020", "smpte432"},
    "color_trc": {"bt709", "gamma22", "gamma28", "smpte170m", "smpte240m", "linear", "iec61966-2-1", "bt2020-10", "bt2020-12", "smpte2084", "arib-std-b67"},
    "colorspace": {"bt709", "bt470bg", "smpte170m", "bt2020nc", "bt2020c", "smpte240m"},
    "color_range": {"tv", "pc"},
}
_RANGE_ALIASES = {"limited": "tv", "full": "pc"}


def _sanitize_color_meta(raw: dict) -> dict:
    out = {}
    for key, allowed in _COLOR_WHITELIST.items():
        val = str(raw.get(key) or "").strip().lower()
        if key == "color_range":
            val = _RANGE_ALIASES.get(val, val)
        if val in allowed:
            out[key] = val
    tc = str(raw.get("timecode") or "").strip()
    if re.match(r"^\d{2}:\d{2}:\d{2}[:;]\d{2}$", tc):
        out["timecode"] = tc
    return out


def probe_source_meta(path: str) -> dict:
    """ffprobe color tags/range/timecode from source video; {} on any failure."""
    if not path or not os.path.isfile(path):
        return {}
    cmd = [_ffprobe(), "-v", "quiet", "-select_streams", "v:0",
           "-show_entries", "stream=color_primaries,color_transfer,color_space,color_range:stream_tags=timecode:format_tags=timecode",
           "-of", "json", path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode:
        return {}
    try:
        data = json.loads(proc.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        raw = {
            "color_primaries": stream.get("color_primaries"),
            "color_trc": stream.get("color_transfer"),
            "colorspace": stream.get("color_space"),
            "color_range": stream.get("color_range"),
            "timecode": (stream.get("tags") or {}).get("timecode") or (data.get("format") or {}).get("tags", {}).get("timecode"),
        }
    except Exception:
        return {}
    return _sanitize_color_meta(raw)


def probe_video(path: str) -> dict:
    """Public geometry/rate probe: width, height, nb_frames (or None), fps."""
    cmd = [_ffprobe(), "-v", "quiet", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,nb_frames,r_frame_rate", "-of", "json", path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode:
        raise RuntimeError(
            f"probe_video: ffprobe failed for {path!r}: "
            f"{(proc.stderr or proc.stdout)[-1000:]}"
        )
    try:
        data = json.loads(proc.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        width = int(stream.get("width"))
        height = int(stream.get("height"))
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"probe_video: cannot read width/height for {path!r}: {exc}")
    nb = stream.get("nb_frames")
    nb_frames = None
    if nb not in (None, "N/A"):
        try:
            nb_frames = int(nb)
        except (ValueError, TypeError):
            nb_frames = None
    fps = None
    rate = str(stream.get("r_frame_rate") or "")
    if "/" in rate:
        num, den = rate.split("/", 1)
        try:
            if float(den):
                fps = float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            fps = None
    return {"width": width, "height": height, "nb_frames": nb_frames, "fps": fps}


def _read_exact(stream, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def _decode_stream(path, pix_fmt, ch, w, h, expected, total, stage, offset, progress_cb,
                   dtype=np.uint8, bytes_per_sample=1, scale=255.0):
    """Decode one rawvideo stream into a float32 array; return (array, count)."""
    per_frame = w * h * ch * bytes_per_sample
    frame_shape = (h, w) if ch == 1 else (h, w, ch)
    cmd = [_ffmpeg(), "-y", "-i", path, "-map", "0:v:0", "-an",
           "-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    stderr_file = tempfile.TemporaryFile()
    proc = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=stderr_file)
        if expected:
            buf = np.empty((expected,) + frame_shape, dtype=np.float32)
            count = 0
            while True:
                chunk = _read_exact(proc.stdout, per_frame)
                if not chunk:
                    break
                if count >= expected:
                    raise RuntimeError(
                        f"decode_video: {stage}: ffmpeg produced more than expected "
                        f"{expected} frames for {path!r}"
                    )
                if len(chunk) != per_frame:
                    raise RuntimeError(
                        f"decode_video: {stage}: short read for {path!r} frame {count}: "
                        f"expected {per_frame} bytes, got {len(chunk)}"
                    )
                buf[count] = np.frombuffer(chunk, dtype).reshape(frame_shape) * (1.0 / scale)
                count += 1
                if progress_cb:
                    progress_cb(count + offset, total, stage)
            if count < expected:
                raise RuntimeError(
                    f"decode_video: {stage}: undershoot for {path!r}: "
                    f"expected {expected} frames, got {count}"
                )
        else:
            # No frame count from metadata or ffprobe: accumulate then stack.
            frames = []
            while True:
                chunk = _read_exact(proc.stdout, per_frame)
                if not chunk:
                    break
                if len(chunk) != per_frame:
                    raise RuntimeError(
                        f"decode_video: {stage}: short read for {path!r} frame {len(frames)}: "
                        f"expected {per_frame} bytes, got {len(chunk)}"
                    )
                frames.append(np.frombuffer(chunk, dtype).reshape(frame_shape))
                if progress_cb:
                    progress_cb(len(frames) + offset, total, stage)
            buf = np.stack(frames, axis=0).astype(np.float32) * (1.0 / scale)
            count = len(frames)
        proc.stdout.close()
        rc = proc.wait()
        if rc:
            stderr_file.seek(0)
            tail = stderr_file.read()[-1000:]
            raise RuntimeError(
                f"decode_video: {stage}: ffmpeg exit {rc} decoding {path!r}: {tail}"
            )
        return buf, count
    except Exception:
        if proc is not None:
            proc.kill()
            proc.wait()
        raise
    finally:
        stderr_file.close()


def decode_video(
    main_path: str,
    mask_path: Optional[str] = None,
    expected_frames: Optional[int] = None,
    progress_cb=None,
) -> Tuple[torch.Tensor, torch.Tensor, int, int, int]:
    """Decode main (and optional mask) video into float32 tensors.

    Returns (IMAGE BHWC, MASK BHW, width, height, frame_count). Without a mask
    file the mask is all-keep (zeros), matching ComfyUI's mask convention."""
    pix_fmt, dtype, bps, scale = _rgb_transport()
    main_probe = probe_video(main_path)
    w, h, nb_main = main_probe["width"], main_probe["height"], main_probe["nb_frames"]
    if mask_path:
        mask_probe = probe_video(mask_path)
        if (mask_probe["width"], mask_probe["height"]) != (w, h):
            raise RuntimeError(
                f"decode_video: mask geometry {mask_probe['width']}x{mask_probe['height']} "
                f"!= main {w}x{h} ({mask_path!r})"
            )
    expected = expected_frames if expected_frames else nb_main
    total = (2 * expected + 1) if (expected and mask_path) else (
        expected + 1 if expected else None
    )

    main_buf, main_count = _decode_stream(
        main_path, pix_fmt, 3, w, h, expected, total, "decoding source", 0, progress_cb,
        dtype=dtype, bytes_per_sample=bps, scale=scale,
    )

    if mask_path:
        mask_offset = expected if expected else main_count
        mask_buf, mask_count = _decode_stream(
            mask_path, "gray", 1, w, h, expected, total, "decoding mask", mask_offset, progress_cb
        )
        if main_count != mask_count:
            raise RuntimeError(
                f"decode_video: frame count mismatch - main {main_count} vs mask {mask_count}"
            )
        mask_tensor = torch.from_numpy(mask_buf).contiguous()
    else:
        mask_tensor = torch.zeros((main_count, h, w), dtype=torch.float32)

    if not main_count:
        raise RuntimeError("decode_video: ffmpeg produced no frames")

    if progress_cb:
        progress_cb(total if total else main_count, total, "video ready")

    return (
        torch.from_numpy(main_buf).contiguous(),
        mask_tensor,
        w, h, main_count,
    )


def encode_video(
    image: torch.Tensor,
    output_path: str,
    fmt: str,
    mov_codec: str,
    fps: float,
    source_meta: Optional[dict] = None,
    progress_cb=None,
    extra_steps: int = 0,
) -> None:
    pix_fmt, dtype, _bps, scale = _rgb_transport()
    if image.dim() == 3:
        image = image.unsqueeze(0)
    arr = image.clamp(0.0, 1.0).detach().cpu().numpy()
    B, H, W, C = arr.shape
    total = B + 1 + extra_steps

    cmd = [_ffmpeg(), "-y", "-f", "rawvideo", "-pix_fmt", pix_fmt,
           "-video_size", f"{W}x{H}", "-framerate", str(float(fps)), "-i", "-"]
    if fmt == "mov":
        profile = "4" if mov_codec == "prores_4444" else "3"
        pix_fmt = "yuva444p10le" if mov_codec == "prores_4444" else "yuv422p10le"
        cmd += ["-c:v", "prores_ks", "-profile:v", profile, "-pix_fmt", pix_fmt]
    else:
        cmd += ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"]
    meta = _sanitize_color_meta(source_meta or {})
    # Fallback tags assume BT.709 tv-range, the dominant AE delivery case.
    fallback = {"color_primaries": "bt709", "color_trc": "bt709", "colorspace": "bt709", "color_range": "tv"}
    merged = {**fallback, **meta}
    cmd += ["-color_primaries", merged["color_primaries"],
            "-color_trc", merged["color_trc"],
            "-colorspace", merged["colorspace"],
            "-color_range", merged["color_range"]]
    # setparams tags the frames themselves; output -color_* flags alone do not
    # reliably stamp color metadata into ProRes from untagged raw frames.
    setparams = (
        f"setparams=color_primaries={merged['color_primaries']}"
        f":color_trc={merged['color_trc']}"
        f":colorspace={merged['colorspace']}"
        f":range={merged['color_range']}"
    )
    cmd += ["-vf", setparams]
    if "timecode" in merged:
        cmd += ["-timecode", merged["timecode"]]
    cmd.append(output_path)

    stderr_file = tempfile.TemporaryFile()
    proc = None
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=stderr_file)
        try:
            for idx in range(B):
                frame = (arr[idx, :, :, :3] * scale).round().astype(dtype)
                proc.stdin.write(frame.tobytes())
                if progress_cb:
                    progress_cb(idx + 1, total, "encoding frames")
            proc.stdin.close()
            if progress_cb:
                progress_cb(B + 1, total, f"finalizing {fmt}")
        except (BrokenPipeError, OSError):
            proc.kill()
            proc.wait()
            stderr_file.seek(0)
            tail = stderr_file.read()[-1000:]
            raise RuntimeError(f"encode_video: write to ffmpeg failed for {output_path!r}: {tail}")
        rc = proc.wait()
        if rc:
            stderr_file.seek(0)
            tail = stderr_file.read()[-1000:]
            raise RuntimeError(f"encode_video: ffmpeg exit {rc} encoding {output_path!r}: {tail}")
    except Exception:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        raise
    finally:
        stderr_file.close()


def encode_mask_video(mask: torch.Tensor, output_path: str, fps: float) -> None:
    """Encode a MASK batch (BHW float32) as a grayscale MP4."""
    if mask.dim() == 4:
        mask = mask.squeeze(-1)
    rgb = mask.clamp(0.0, 1.0).unsqueeze(-1).repeat(1, 1, 1, 3)
    encode_video(rgb, output_path, "mp4", "", fps, source_meta={})
