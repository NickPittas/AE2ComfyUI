"""aiohttp routes for the AE bridge.

Registered on ComfyUI's PromptServer. AE is the HTTP client; no server runs
inside AE.

Routes:
  GET  /ae_bridge/health
  POST /ae_bridge/assets            multipart: job_id, asset_id, metadata, file
  GET  /ae_bridge/jobs/{job_id}
  GET  /ae_bridge/jobs/{job_id}/result
"""

from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any, Dict

from . import job_store

_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")

_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "mov": "video/quicktime",
    "mp4": "video/mp4",
}


def _clean_asset_id(asset_id: Any) -> str:
    aid = str(asset_id or "").strip()
    if not _ASSET_ID_RE.match(aid):
        raise ValueError(f"invalid asset_id: {asset_id!r}")
    return aid


def _clean_ext(filename: Any) -> str:
    ext = os.path.splitext(str(filename or ""))[1].lower()
    return ext if _EXT_RE.match(ext) else ""


def register_handlers(dispatcher: Any) -> bool:
    """Register handlers on an aiohttp UrlDispatcher. Returns True on success."""
    try:
        from aiohttp import web  # only available inside ComfyUI / test env
    except Exception:
        return False

    # CEP panels run from a file:// origin; without these headers Chromium
    # blocks the panel's fetch calls depending on CEF security flags.
    _CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    def _with_cors(handler):
        async def wrapped(request):
            resp = await handler(request)
            for key, value in _CORS_HEADERS.items():
                resp.headers[key] = value
            return resp
        return wrapped

    async def _options(_request):
        return web.Response(headers=_CORS_HEADERS)

    async def _health(_request: Any) -> Any:
        return web.json_response({"ok": True, "app": "ae2comfyui"})

    async def _post_asset(request: Any) -> Any:
        fields: Dict[str, Any] = {}
        tmp_path = os.path.join(
            job_store._staging_root(), f".upload-{uuid.uuid4().hex}.part"
        )
        filename = ""
        try:
            reader = await request.multipart()
            async for part in reader:
                if part.name == "file":
                    filename = part.filename or "asset.bin"
                    with open(tmp_path, "wb") as fh:
                        while True:
                            chunk = await part.read_chunk(1024 * 1024)
                            if not chunk:
                                break
                            fh.write(chunk)
                else:
                    fields[part.name] = await part.text()

            job_id = str(fields.get("job_id") or "").strip()
            metadata_raw = fields.get("metadata") or "{}"
            try:
                metadata = json.loads(metadata_raw)
                if not isinstance(metadata, dict):
                    raise ValueError("metadata must be a JSON object")
            except (ValueError, TypeError) as exc:
                return web.json_response(
                    {"ok": False, "error": f"bad metadata: {exc}"}, status=400
                )
            try:
                asset_id = _clean_asset_id(fields.get("asset_id"))
                entry = job_store.create_job(job_id, metadata)
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": str(exc)}, status=400
                )
            if not os.path.isfile(tmp_path) or os.path.getsize(tmp_path) <= 0:
                return web.json_response(
                    {"ok": False, "error": "missing or empty file field"}, status=400
                )

            ext = _clean_ext(filename)
            dest = os.path.join(entry["dir"], f"{asset_id}{ext}")
            os.replace(tmp_path, dest)
            job_store.store_asset(job_id, asset_id, dest)
            return web.json_response({"ok": True, "path": dest})
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": f"asset upload failed: {exc}"}, status=500
            )
        finally:
            if os.path.isfile(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    async def _get_job(request: Any) -> Any:
        entry = job_store.get_job(request.match_info["job_id"])
        if entry is None:
            return web.json_response(
                {"ok": False, "error": "unknown or expired job_id"}, status=404
            )
        assets = {
            aid: os.path.basename(p) for aid, p in entry["assets"].items()
        }
        result = entry.get("result")
        return web.json_response(
            {
                "ok": True,
                "metadata": entry["metadata"],
                "assets": assets,
                "result": None
                if result is None
                else {"file": os.path.basename(result["path"]),
                      "metadata": result["metadata"]},
            }
        )

    async def _get_result(request: Any) -> Any:
        job_id = request.match_info["job_id"]
        result = job_store.get_result(job_id)
        if result is None:
            return web.json_response(
                {"ok": False, "error": "result not ready"}, status=404
            )
        path = result["path"]
        if not os.path.isfile(path):
            return web.json_response(
                {"ok": False, "error": f"result file missing: {path}"}, status=404
            )
        meta = result.get("metadata") or {}
        fmt = str(meta.get("format") or _clean_ext(path).lstrip(".") or "bin")
        headers = {
            "X-AEBridge-Format": fmt,
            "X-AEBridge-Width": str(meta.get("width") or ""),
            "X-AEBridge-Height": str(meta.get("height") or ""),
        }
        if meta.get("frame_count"):
            headers["X-AEBridge-Frame-Count"] = str(meta["frame_count"])
        if meta.get("fps"):
            headers["X-AEBridge-FPS"] = str(meta["fps"])
        if meta.get("duration_seconds"):
            headers["X-AEBridge-Duration"] = str(meta["duration_seconds"])
        return web.Response(
            body=open(path, "rb").read(),
            content_type=_CONTENT_TYPES.get(fmt, "application/octet-stream"),
            headers=headers,
        )

    spec = (
        ("GET", "/ae_bridge/health", _health),
        ("POST", "/ae_bridge/assets", _post_asset),
        ("GET", "/ae_bridge/jobs/{job_id}", _get_job),
        ("GET", "/ae_bridge/jobs/{job_id}/result", _get_result),
    )
    for method, path, handler in spec:
        try:
            getattr(dispatcher, "add_" + method.lower())(path, _with_cors(handler))
            dispatcher.add_options(path, _options)
        except Exception:
            try:
                getattr(dispatcher, method.lower())(path)(_with_cors(handler))
            except Exception:
                pass
    return True


def add_routes(server: Any) -> bool:
    """Register routes on a PromptServer instance. Returns True on success."""
    routes = getattr(server, "routes", None)
    if routes is None:
        return False
    return register_handlers(routes)
