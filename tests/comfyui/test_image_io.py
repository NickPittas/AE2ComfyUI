"""Image I/O round-trip tests (PNG/JPG, alpha/mask conventions)."""

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from comfyui.ae_bridge import image_io


def make_image(w=8, h=4):
    arr = torch.rand((1, h, w, 3), dtype=torch.float32)
    return arr


def make_mask(w=8, h=4):
    mask = torch.zeros((1, h, w), dtype=torch.float32)
    mask[0, : h // 2, :] = 1.0  # top half masked (transparent in AE terms)
    return mask


def test_png_roundtrip_preserves_rgb():
    image = make_image()
    body, ctype, tag = image_io.encode_image_bytes(image, "png")
    assert tag == "png" and ctype == "image/png"
    decoded, mask, w, h = image_io.decode_image_bytes(body, "png")
    assert (w, h) == (8, 4)
    assert torch.allclose(decoded, image, atol=2 / 255.0)
    assert float(mask.max()) == 0.0  # opaque in, keep-mask out


def test_png_mask_embedded_as_alpha_and_inverts_back():
    image, mask = make_image(), make_mask()
    body, _, _ = image_io.encode_image_bytes(image, "png", mask)
    decoded, out_mask, _, _ = image_io.decode_image_bytes(body, "png")
    assert torch.allclose(out_mask, mask, atol=2 / 255.0)
    # top half was masked=1 (AE alpha 0), bottom half keep=0 (alpha 1)
    assert float(out_mask[0, 0, 0]) > 0.9
    assert float(out_mask[0, -1, 0]) < 0.1


def test_jpg_roundtrip_opaque():
    # Smooth gradient: representative of real content; random noise is a
    # pathological JPEG input and would need a meaningless tolerance.
    w, h = 16, 16
    x = torch.linspace(0.0, 1.0, w)
    y = torch.linspace(0.0, 1.0, h)
    image = torch.stack(
        [x.expand(h, w), y[:, None].expand(h, w), torch.full((h, w), 0.5)], dim=-1
    ).unsqueeze(0)
    body, ctype, tag = image_io.encode_image_bytes(image, "jpg")
    assert tag == "jpg" and ctype == "image/jpeg"
    decoded, mask, w, h = image_io.decode_image_bytes(body, "jpg")
    assert (w, h) == (16, 16)
    assert float(mask.max()) == 0.0
    assert torch.allclose(decoded, image, atol=0.05)  # jpeg lossy


def test_jpg_ignores_mask():
    body, _, tag = image_io.encode_image_bytes(make_image(), "jpg", make_mask())
    _, mask, _, _ = image_io.decode_image_bytes(body, "jpg")
    assert float(mask.max()) == 0.0


def test_format_normalization():
    assert image_io.normalize_format("PNG") == "png"
    assert image_io.normalize_format("jpeg") == "jpg"
    assert image_io.normalize_format("bogus") == "png"
    assert image_io.normalize_format(None) == "png"


def test_decode_real_png_with_alpha():
    from PIL import Image
    import io

    arr = np.zeros((4, 8, 4), dtype=np.uint8)
    arr[:, :, 3] = np.linspace(0, 255, 8, dtype=np.uint8)[None, :]
    buf = io.BytesIO()
    Image.fromarray(arr, "RGBA").save(buf, format="PNG")
    _, mask, w, h = image_io.decode_image_bytes(buf.getvalue(), "png")
    assert (w, h) == (8, 4)
    assert float(mask[0, 0, 0]) > 0.9  # alpha 0 -> masked
    assert float(mask[0, 0, -1]) < 0.1  # alpha 255 -> keep


def test_png_srgb_icc_embedded_on_request():
    from PIL import Image
    import io

    body, _, _ = image_io.encode_image_bytes(make_image(), "png", embed_srgb_icc=True)
    info = Image.open(io.BytesIO(body)).info
    icc = info.get("icc_profile")
    if image_io._srgb_icc_bytes() is None:
        assert not icc  # ImageCms unavailable: silently skipped
    else:
        # lcms-generated sRGB profile; no literal 'sRGB' string inside.
        assert icc and len(bytes(icc)) > 100


def test_png_no_icc_by_default():
    from PIL import Image
    import io

    body, _, _ = image_io.encode_image_bytes(make_image(), "png")
    assert not Image.open(io.BytesIO(body)).info.get("icc_profile")
