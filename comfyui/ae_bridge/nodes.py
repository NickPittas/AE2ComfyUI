"""ComfyUI custom nodes: FromAE / ToAE (image) and FromAEVideo / ToAEVideo.

All nodes are job-scoped: AE uploads assets to /ae_bridge/assets before
queueing, patches `job_id`/`asset_id` into these nodes, and retrieves the
result registered by ToAE/ToAEVideo after execution. See PROTOCOL.md.
"""

from __future__ import annotations

import json
import os
import uuid
from typing import Any, Dict, Optional, Tuple

import torch

from . import image_io, job_store, video_io


def _unique_result_path(job_id: str, prefix: str, ext: str) -> str:
    entry = job_store.get_job(job_id)
    if entry is None:
        raise RuntimeError(f"ToAE: unknown or expired job_id: {job_id!r}")
    safe_prefix = "".join(
        c if c.isalnum() or c in "-_" else "_" for c in (prefix or "ae_result")
    )
    for idx in range(1000):
        name = f"{safe_prefix}.%03d.{ext}" % idx if idx else f"{safe_prefix}.{ext}"
        path = os.path.join(entry["dir"], name)
        if not os.path.exists(path):
            return path
    raise RuntimeError("ToAE: could not allocate a unique result filename")


def _comfy_output_dir() -> str:
    """Return ComfyUI's writable standard output directory or fail clearly."""
    try:
        import folder_paths  # type: ignore  # only inside ComfyUI

        output_dir = os.path.abspath(folder_paths.get_output_directory())
        os.makedirs(output_dir, exist_ok=True)
        probe_path = os.path.join(output_dir, f".ae2c-write-{uuid.uuid4().hex}.tmp")
        try:
            with open(probe_path, "xb"):
                pass
        finally:
            if os.path.exists(probe_path):
                os.unlink(probe_path)
        return output_dir
    except Exception as exc:
        raise RuntimeError(
            f"ToAEVideo: ComfyUI output folder is not writable: {exc}"
        ) from exc


def _unique_output_path(output_dir: str, prefix: str, ext: str, job_id: str) -> str:
    safe_prefix = "".join(
        c if c.isalnum() or c in "-_" else "_" for c in (prefix or "ae_video_result")
    )
    safe_job_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_id)
    for idx in range(1000):
        stem = f"{safe_prefix}.{safe_job_id}"
        name = f"{stem}.%03d.{ext}" % idx if idx else f"{stem}.{ext}"
        path = os.path.join(output_dir, name)
        if not os.path.exists(path):
            return path
    raise RuntimeError("ToAEVideo: could not allocate a unique ComfyUI output filename")


def _job_metadata(job_id: str) -> Dict[str, Any]:
    entry = job_store.get_job(job_id)
    if entry is None:
        raise RuntimeError(f"unknown or expired job_id: {job_id!r}")
    return entry.get("metadata") or {}


class FromAE:
    """Load a full-comp AE still and its optional selected-layer mask."""

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "job_id": ("STRING", {"default": "", "multiline": False}),
                "asset_id": ("STRING", {"default": "main", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "prompt", "width", "height")
    FUNCTION = "pull"
    CATEGORY = "AEBridge"

    def pull(self, job_id: str, asset_id: str) -> Tuple[torch.Tensor, torch.Tensor, str, int, int]:
        jid = (job_id or "").strip()
        if not jid:
            raise RuntimeError("FromAE: job_id is empty — queue from the AE panel")
        path = job_store.get_asset(jid, (asset_id or "main").strip())
        with open(path, "rb") as fh:
            body = fh.read()
        if not body:
            raise RuntimeError(f"FromAE: empty asset file: {path!r}")
        fmt = os.path.splitext(path)[1].lstrip(".")
        image, mask, width, height = image_io.decode_image_bytes(body, fmt)
        metadata = _job_metadata(jid)
        if str(metadata.get("mask_mode") or "none") != "none":
            mask_path = job_store.get_asset(jid, "mask")
            with open(mask_path, "rb") as fh:
                mask_body = fh.read()
            if not mask_body:
                raise RuntimeError(f"FromAE: empty mask asset file: {mask_path!r}")
            mask, mask_width, mask_height = image_io.decode_mask_bytes(mask_body)
            if (mask_width, mask_height) != (width, height):
                raise RuntimeError(
                    "FromAE: mask geometry "
                    f"{mask_width}x{mask_height} != main {width}x{height}"
                )
        prompt = str(metadata.get("prompt") or "")
        return (image, mask, prompt, width, height)

    @staticmethod
    def IS_CHANGED(**kwargs: Any) -> float:
        # Force re-read on every execution; assets may be replaced between runs.
        return float(uuid.uuid4().int)


class ToAE:
    """Write an IMAGE back into the job so the AE panel can download it."""

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "job_id": ("STRING", {"default": "", "multiline": False}),
                "filename_prefix": ("STRING", {"default": "ae_result"}),
                "format": (["png", "jpg"], {"default": "png"}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "push"
    CATEGORY = "AEBridge"
    OUTPUT_NODE = True

    def push(
        self,
        image: torch.Tensor,
        job_id: str,
        filename_prefix: str,
        format: str,
        mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor]:
        jid = (job_id or "").strip()
        if not jid:
            raise RuntimeError("ToAE: job_id is empty — queue from the AE panel")
        fmt = image_io.normalize_format(format)
        # JPG cannot carry alpha; a connected mask is dropped with a warning.
        if mask is not None and fmt == "jpg":
            print("[AEBridge] ToAE: mask ignored for jpg output", flush=True)
            mask = None
        meta = _job_metadata(jid)
        embed_icc = str(meta.get("bridge_color_mode") or "") == "srgb"
        body, _content_type, _tag = image_io.encode_image_bytes(
            image, fmt, mask, embed_srgb_icc=embed_icc
        )
        path = _unique_result_path(jid, filename_prefix, fmt)
        with open(path, "wb") as fh:
            fh.write(body)
        height, width = int(image.shape[1]), int(image.shape[2])
        job_store.set_result(
            jid, path, {"format": fmt, "width": width, "height": height}
        )
        return (image,)


class _VideoProgress:
    """Print [AEBridge] <stage> on stage changes; drive comfy ProgressBar."""

    def __init__(self, total: Optional[int]):
        self._total = total
        self._stage = None
        self._bar = None
        if total:
            try:
                from comfy.utils import ProgressBar
                self._bar = ProgressBar(total)
            except Exception:
                self._bar = None  # standalone / test context: no server hook

    def __call__(self, completed, total, stage):
        if stage != self._stage:
            print(f"[AEBridge] {stage}", flush=True)
            self._stage = stage
        if self._bar is not None and completed is not None and total:
            self._bar.update_absolute(min(completed, total), total)


class FromAEVideo:
    """Load AE video frames, timing metadata, and the AE panel prompt."""

    DESCRIPTION = (
        "Loads the video exported from After Effects. The prompt output carries "
        "the AE panel prompt; connect it to the workflow's text encoder. "
        "video_meta_json carries the source timing and output settings."
    )

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "job_id": ("STRING", {"default": "", "multiline": False}),
                "asset_id": ("STRING", {"default": "main", "multiline": False}),
            },
        }

    RETURN_TYPES = (
        "IMAGE", "MASK", "INT", "INT", "INT", "FLOAT", "FLOAT", "STRING", "STRING"
    )
    RETURN_NAMES = (
        "image", "mask", "width", "height",
        "frame_count", "fps", "duration_seconds", "video_meta_json", "prompt",
    )
    OUTPUT_TOOLTIPS = (
        "Decoded source video frames as an IMAGE batch.",
        "Decoded selected-layer mask; 0 keeps and 1 marks pixels for processing.",
        "Source video width in pixels.",
        "Source video height in pixels.",
        "Decoded source frame count.",
        "Source video frame rate.",
        "Source video duration in seconds.",
        "AE job metadata. Connect this to To AE Video to pass timing and output settings.",
        "Prompt entered in the AE2ComfyUI panel. Connect this to the video text encoder.",
    )
    FUNCTION = "pull"
    CATEGORY = "AEBridge"

    def pull(self, job_id: str, asset_id: str):
        jid = (job_id or "").strip()
        if not jid:
            raise RuntimeError("FromAEVideo: job_id is empty — queue from the AE panel")
        meta = _job_metadata(jid)
        main_path = job_store.get_asset(jid, (asset_id or "main").strip())
        mask_path = None
        if str(meta.get("mask_mode") or "none") != "none":
            mask_path = job_store.get_asset(jid, "mask")
        expected = int(meta["frame_count"]) if meta.get("frame_count") else None
        main_size = os.path.getsize(main_path)
        print(
            f"[AEBridge] FromAEVideo: decoding main {main_path} "
            f"({main_size} bytes, expected {expected or '?'} frames)",
            flush=True,
        )
        if mask_path:
            print(
                f"[AEBridge] FromAEVideo: decoding mask {mask_path} "
                f"({os.path.getsize(mask_path)} bytes)",
                flush=True,
            )
        report = _VideoProgress(2 * expected + 1 if expected and mask_path else expected)
        image, mask, width, height, frame_count = video_io.decode_video(
            main_path, mask_path, expected_frames=expected, progress_cb=report
        )
        print(
            f"[AEBridge] FromAEVideo: decoded {frame_count} frames "
            f"{width}x{height} from {main_path}",
            flush=True,
        )
        fps = float(meta.get("fps") or 24.0)
        duration = float(meta.get("duration_seconds") or frame_count / fps)
        return (
            image, mask, width, height, frame_count,
            fps, duration, json.dumps(meta), str(meta.get("prompt") or ""),
        )

    @staticmethod
    def IS_CHANGED(**kwargs: Any) -> float:
        return float(uuid.uuid4().int)


class ToAEVideo:
    """Encode an IMAGE batch directly to ComfyUI output and register it for AE."""

    DESCRIPTION = (
        "Writes the connected IMAGE batch back to After Effects. The AE panel "
        "sets the job ID, output container, and ProRes codec for each run. "
        "Connect video_meta_json from From AE Video when available; otherwise "
        "the node reads the uploaded AE job metadata automatically."
    )

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "job_id": ("STRING", {
                    "default": "", "multiline": False,
                    "tooltip": "Filled automatically by the AE2ComfyUI panel.",
                }),
                "filename_prefix": ("STRING", {
                    "default": "ae_video_result",
                    "tooltip": "Filename prefix for the MOV/MP4 saved in ComfyUI's output folder.",
                }),
                "format_override": (["auto", "mp4", "mov"], {
                    "default": "auto",
                    "tooltip": "Usually left at auto. The AE panel applies the selected output format.",
                }),
                "mov_codec_override": (
                    ["auto", "prores_422hq", "prores_4444"], {
                        "default": "auto",
                        "tooltip": "Used for MOV output. The AE panel applies its selected ProRes codec.",
                    }
                ),
            },
            "optional": {
                "mask": ("MASK",),
                "video_meta_json": ("STRING", {
                    "tooltip": (
                        "Optional AE job metadata. Connect the video_meta_json output "
                        "from From AE Video; if unconnected, metadata is read from the job automatically."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "push"
    CATEGORY = "AEBridge"
    OUTPUT_NODE = True

    def push(
        self,
        image: torch.Tensor,
        job_id: str,
        video_meta_json: Optional[str] = None,
        filename_prefix: str = "ae_video_result",
        format_override: str = "auto",
        mov_codec_override: str = "auto",
        mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor]:
        jid = (job_id or "").strip()
        if not jid:
            raise RuntimeError("ToAEVideo: job_id is empty — queue from the AE panel")
        try:
            meta = json.loads(video_meta_json or "{}")
            if not isinstance(meta, dict):
                meta = {}
        except Exception:
            meta = {}
        if not meta:
            meta = _job_metadata(jid)

        fmt = str(meta.get("video_format") or "mov")
        if format_override != "auto":
            fmt = format_override
        if fmt not in ("mov", "mp4"):
            fmt = "mov"
        mov_codec = str(meta.get("mov_codec") or "prores_4444")
        if mov_codec_override != "auto":
            mov_codec = mov_codec_override
        if mov_codec not in ("prores_422hq", "prores_4444"):
            mov_codec = "prores_4444"
        fps = float(meta.get("fps") or 24.0)

        main_asset = ""
        try:
            main_asset = job_store.get_asset(jid, "main")
        except Exception:
            pass
        source_meta = video_io.probe_source_meta(main_asset)

        frame_count = int(image.shape[0])
        output_dir = _comfy_output_dir()
        path = _unique_output_path(output_dir, filename_prefix, fmt, jid)
        report = _VideoProgress(frame_count + 1)
        video_io.encode_video(
            image, path, fmt, mov_codec, fps,
            source_meta=source_meta, progress_cb=report,
        )
        result_meta = {
            "format": fmt,
            "width": int(image.shape[2]),
            "height": int(image.shape[1]),
            "frame_count": frame_count,
            "fps": fps,
            "duration_seconds": frame_count / fps if fps else 0.0,
        }
        # AE copies this exact local file to its configured results folder.
        result_meta["comfy_output_path"] = path
        if mask is not None:
            mask_path = os.path.splitext(path)[0] + "_mask.mp4"
            video_io.encode_mask_video(mask, mask_path, fps)
            result_meta["mask_file"] = mask_path
        job_store.set_result(jid, path, result_meta)
        report(frame_count + 1, frame_count + 1, "complete")
        return (image,)
