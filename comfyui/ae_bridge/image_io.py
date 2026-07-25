"""Image <-> ComfyUI tensor helpers (PNG + JPG).

ComfyUI IMAGE: BHWC float32 in [0,1].
ComfyUI MASK:  BHW float32, convention 0 = keep/opaque, 1 = masked/transparent.
AE alpha:      1 = opaque, 0 = transparent. Carrier conversion: mask = 1 - alpha.

PNG keeps alpha (RGBA); JPG is opaque-only (encode drops the mask, decode
returns an all-keep mask). JPG is a convenience format — prefer PNG when color
or alpha fidelity matters.
"""

from __future__ import annotations

import io
from typing import Optional, Tuple

import numpy as np
import torch
from PIL import Image

FORMATS = ("png", "jpg")


def normalize_format(fmt: object) -> str:
    value = str(fmt or "png").strip().lower()
    if value == "jpeg":
        value = "jpg"
    return value if value in FORMATS else "png"


def decode_image_bytes(data: bytes, fmt: object) -> Tuple[torch.Tensor, torch.Tensor, int, int]:
    """Decode PNG/JPG bytes into (IMAGE, MASK, width, height)."""
    fmt = normalize_format(fmt)
    img = Image.open(io.BytesIO(data))
    if fmt == "png" and ("A" in img.getbands()):
        img = img.convert("RGBA")
        arr = np.asarray(img).astype(np.float32) / 255.0
        rgb, alpha = arr[:, :, :3], arr[:, :, 3]
    else:
        img = img.convert("RGB")
        rgb = np.asarray(img).astype(np.float32) / 255.0
        alpha = np.ones(rgb.shape[:2], dtype=np.float32)

    height, width = rgb.shape[0], rgb.shape[1]
    image = torch.from_numpy(np.ascontiguousarray(rgb)).unsqueeze(0)
    mask = torch.from_numpy(np.ascontiguousarray(1.0 - alpha)).unsqueeze(0)
    return image, mask, width, height


def encode_image_bytes(
    image: torch.Tensor,
    fmt: object,
    mask: Optional[torch.Tensor] = None,
) -> Tuple[bytes, str, str]:
    """Encode an IMAGE tensor; returns (bytes, content_type, format_tag).

    PNG embeds `mask` as the alpha channel when provided (alpha = 1 - mask).
    JPG always encodes opaque RGB at quality 95.
    """
    fmt = normalize_format(fmt)
    if image.dim() == 3:
        image = image.unsqueeze(0)
    arr = image[0].clamp(0.0, 1.0).detach().cpu().numpy()
    arr8 = (arr[:, :, :3] * 255.0).round().astype(np.uint8)

    if fmt == "jpg":
        img = Image.fromarray(arr8, mode="RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95)
        return buf.getvalue(), "image/jpeg", "jpg"

    if mask is not None:
        if mask.dim() == 3:
            mask = mask[0]
        m = mask.clamp(0.0, 1.0).detach().cpu().numpy()
        alpha8 = ((1.0 - m) * 255.0).round().astype(np.uint8)
        rgba = np.dstack([arr8, alpha8])
        img = Image.fromarray(rgba, mode="RGBA")
    else:
        img = Image.fromarray(arr8, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), "image/png", "png"
