"""ComfyUI custom nodes: FromAE / ToAE (image) and FromAEVideo / ToAEVideo.

All nodes are job-scoped: AE uploads assets to /ae_bridge/assets before
queueing, patches `job_id`/`asset_id` into these nodes, and downloads the
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


def _job_metadata(job_id: str) -> Dict[str, Any]:
    entry = job_store.get_job(job_id)
    if entry is None:
        raise RuntimeError(f"unknown or expired job_id: {job_id!r}")
    return entry.get("metadata") or {}


class FromAE:
    """Load an AE-uploaded still image (and its alpha as MASK) from a job."""

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
        prompt = str(_job_metadata(jid).get("prompt") or "")
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
    """Load an AE-uploaded video (+ optional mask MP4) as frame batches."""

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "job_id": ("STRING", {"default": "", "multiline": False}),
                "asset_id": ("STRING", {"default": "main", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "FLOAT", "FLOAT", "STRING")
    RETURN_NAMES = (
        "image", "mask", "width", "height",
        "frame_count", "fps", "duration_seconds", "video_meta_json",
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
        report = _VideoProgress(2 * expected + 1 if expected and mask_path else expected)
        image, mask, width, height, frame_count = video_io.decode_video(
            main_path, mask_path, expected_frames=expected, progress_cb=report
        )
        fps = float(meta.get("fps") or 24.0)
        duration = float(meta.get("duration_seconds") or frame_count / fps)
        return (
            image, mask, width, height, frame_count,
            fps, duration, json.dumps(meta),
        )

    @staticmethod
    def IS_CHANGED(**kwargs: Any) -> float:
        return float(uuid.uuid4().int)


class ToAEVideo:
    """Encode an IMAGE batch to MOV/MP4 and register it as the job result."""

    @staticmethod
    def INPUT_TYPES(cls_dict: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "required": {
                "image": ("IMAGE",),
                "job_id": ("STRING", {"default": "", "multiline": False}),
                "video_meta_json": ("STRING", {"default": "{}", "multiline": True}),
                "filename_prefix": ("STRING", {"default": "ae_video_result"}),
                "format_override": (["auto", "mp4", "mov"], {"default": "auto"}),
                "mov_codec_override": (
                    ["auto", "prores_422hq", "prores_4444"], {"default": "auto"}
                ),
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
        video_meta_json: str,
        filename_prefix: str,
        format_override: str,
        mov_codec_override: str,
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
        path = _unique_result_path(jid, filename_prefix, fmt)
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
        if mask is not None:
            mask_path = os.path.splitext(path)[0] + "_mask.mp4"
            video_io.encode_mask_video(mask, mask_path, fps)
            result_meta["mask_file"] = mask_path
        job_store.set_result(jid, path, result_meta)
        report(frame_count + 1, frame_count + 1, "complete")
        return (image,)
