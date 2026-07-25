"""ComfyUI custom nodes: FromAE / ToAE (image) and FromAEVideo / ToAEVideo.

All nodes are job-scoped: AE uploads assets to /ae_bridge/assets before
queueing, patches `job_id`/`asset_id` into these nodes, and downloads the
result registered by ToAE/ToAEVideo after execution. See PROTOCOL.md.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Dict, Optional, Tuple

import torch

from . import image_io, job_store


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
        body, _content_type, _tag = image_io.encode_image_bytes(image, fmt, mask)
        path = _unique_result_path(jid, filename_prefix, fmt)
        with open(path, "wb") as fh:
            fh.write(body)
        height, width = int(image.shape[1]), int(image.shape[2])
        job_store.set_result(
            jid, path, {"format": fmt, "width": width, "height": height}
        )
        return (image,)
