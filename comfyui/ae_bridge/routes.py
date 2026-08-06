"""aiohttp routes for the AE bridge.

Registered on ComfyUI's PromptServer. AE is the HTTP client; no server runs
inside AE.

Routes:
  GET  /ae_bridge/health
  POST /ae_bridge/assets            multipart: job_id, asset_id, metadata, file
  POST /ae_bridge/assets/begin      chunked upload: JSON {job_id, asset_id, filename, size, metadata}
  POST /ae_bridge/assets/chunk      chunked upload: raw bytes + job_id/asset_id/offset query
  POST /ae_bridge/assets/finish     chunked upload: JSON {job_id, asset_id, size}
  GET  /ae_bridge/jobs/{job_id}
  GET  /ae_bridge/jobs/{job_id}/result   (Range supported)
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from typing import Any, Dict

from . import job_store

log = logging.getLogger("ae_bridge")
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")

# Largest single chunk the panel sends. Kept well under aiohttp's default
# client_max_size (100 MB) so uploads sidestep any unverified server limit.
MAX_CHUNK_BYTES = 16 * 1024 * 1024

_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "mov": "video/quicktime",
    "mp4": "video/mp4",
}

_RESULT_HEADERS = (
    "X-AEBridge-Format, X-AEBridge-Width, X-AEBridge-Height, "
    "X-AEBridge-Frame-Count, X-AEBridge-FPS, X-AEBridge-Duration, "
    "Content-Range, Content-Length"
)


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
    # blocks the panel's fetch calls depending on CEF security flags. Range and
    # the result headers must be exposed: Range triggers a preflight (not a
    # CORS-safelisted header) and the panel reads X-AEBridge-*/Content-Range
    # from the result response.
    _CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Expose-Headers": _RESULT_HEADERS,
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
        return web.json_response(
            {
                "ok": True,
                "app": "ae2comfyui",
                "job_store": {
                    "module": job_store.module_identity(),
                    "jobs": len(job_store.list_jobs()),
                },
            }
        )

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
            log.info("[AEBridge] upload complete job=%s asset=%s size=%d path=%s",
                     job_id, asset_id, os.path.getsize(dest), dest)
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

    # --- chunked upload (large video transport) -----------------------------
    #
    # begin/chunk/finish keeps every request body <= MAX_CHUNK_BYTES and the
    # server writes chunks at offsets without ever loading the whole video.

    async def _begin_upload(request: Any) -> Any:
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            job_id = str(data.get("job_id") or "").strip()
            metadata = data.get("metadata")
            if not isinstance(metadata, dict):
                metadata = {}
            try:
                asset_id = _clean_asset_id(data.get("asset_id"))
                entry = job_store.create_job(job_id, metadata)
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": str(exc)}, status=400
                )
            size = int(data.get("size") or 0)
            if size <= 0:
                return web.json_response(
                    {"ok": False, "error": f"invalid size: {size!r}"}, status=400
                )
            ext = _clean_ext(data.get("filename"))
            final_path = os.path.join(entry["dir"], f"{asset_id}{ext}")
            part_path = final_path + ".part"
            # Fresh attempt: truncate any stale .part from a previous run.
            with open(part_path, "wb"):
                pass
            job_store.begin_upload(job_id, asset_id, part_path, size)
            log.info("[AEBridge] upload begin job=%s asset=%s size=%d part=%s",
                     job_id, asset_id, size, part_path)
            return web.json_response(
                {"ok": True, "asset_id": asset_id, "size": size, "path": final_path}
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": f"upload begin failed: {exc}"}, status=500
            )

    async def _upload_chunk(request: Any) -> Any:
        try:
            job_id = str(request.query.get("job_id") or "").strip()
            asset_id = str(request.query.get("asset_id") or "").strip()
            try:
                asset_id = _clean_asset_id(asset_id)
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": str(exc)}, status=400
                )
            offset = int(request.query.get("offset") or 0)
            if offset < 0:
                return web.json_response(
                    {"ok": False, "error": f"invalid offset: {offset}"}, status=400
                )
            state = job_store.get_upload(job_id, asset_id)
            if state is None:
                return web.json_response(
                    {"ok": False, "error": "no upload in progress; call begin first"},
                    status=400,
                )
            content_length = request.content_length
            if content_length is not None and content_length > MAX_CHUNK_BYTES:
                return web.json_response(
                    {"ok": False, "error": "chunk exceeds 16 MB limit"}, status=413
                )
            data = bytearray()
            async for body_part in request.content.iter_chunked(1024 * 1024):
                data.extend(body_part)
                if len(data) > MAX_CHUNK_BYTES:
                    return web.json_response(
                        {"ok": False, "error": "chunk exceeds 16 MB limit"},
                        status=413,
                    )
            if not data:
                return web.json_response(
                    {"ok": False, "error": "empty chunk body"}, status=400
                )
            expected = int(state.get("size") or 0)
            if offset + len(data) > expected:
                return web.json_response(
                    {
                        "ok": False,
                        "error": (
                            f"chunk exceeds declared upload size: offset {offset}, "
                            f"bytes {len(data)}, expected {expected}"
                        ),
                    },
                    status=400,
                )
            part = state["part_path"]
            with open(part, "r+b") as fh:
                fh.seek(offset)
                fh.write(data)
            job_store.mark_upload_written(job_id, asset_id, offset, len(data))
            if offset == 0:
                log.info("[AEBridge] upload first chunk job=%s asset=%s bytes=%d",
                         job_id, asset_id, len(data))
            return web.json_response(
                {"ok": True, "offset": offset, "written": len(data)}
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": f"upload chunk failed: {exc}"}, status=500
            )

    async def _finish_upload(request: Any) -> Any:
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            job_id = str(data.get("job_id") or "").strip()
            try:
                asset_id = _clean_asset_id(data.get("asset_id"))
            except ValueError as exc:
                return web.json_response(
                    {"ok": False, "error": str(exc)}, status=400
                )
            claimed = int(data.get("size") or 0)
            state = job_store.get_upload(job_id, asset_id)
            if state is None:
                return web.json_response(
                    {"ok": False, "error": "no upload in progress; call begin first"},
                    status=400,
                )
            written = int(state.get("written") or 0)
            expected = int(state.get("size") or 0)
            ranges = state.get("ranges") or []
            complete = ranges == [(0, expected)]
            on_disk = 0
            try:
                on_disk = os.path.getsize(state["part_path"])
            except OSError:
                pass
            if (claimed != expected or written != expected or
                    on_disk != expected or not complete):
                return web.json_response(
                    {
                        "ok": False,
                        "error": (
                            "upload verification failed: claimed "
                            f"{claimed}, expected {expected}, written {written}, "
                            f"on-disk {on_disk}, ranges {ranges}"
                        ),
                    },
                    status=400,
                )
            final_path = state["part_path"][:-5]  # strip ".part"
            os.replace(state["part_path"], final_path)
            job_store.finish_upload(job_id, asset_id, final_path)
            log.info("[AEBridge] upload complete job=%s asset=%s size=%d path=%s",
                     job_id, asset_id, expected, final_path)
            return web.json_response(
                {"ok": True, "asset_id": asset_id, "size": expected, "path": final_path}
            )
        except Exception as exc:
            return web.json_response(
                {"ok": False, "error": f"upload finish failed: {exc}"}, status=500
            )

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
            "Content-Type": _CONTENT_TYPES.get(fmt, "application/octet-stream"),
        }
        if meta.get("frame_count"):
            headers["X-AEBridge-Frame-Count"] = str(meta["frame_count"])
        if meta.get("fps"):
            headers["X-AEBridge-FPS"] = str(meta["fps"])
        if meta.get("duration_seconds"):
            headers["X-AEBridge-Duration"] = str(meta["duration_seconds"])
        # FileResponse streams the file and honors Range (206 + Content-Range)
        # so the panel can download large videos in bounded-memory chunks.
        log.info("[AEBridge] result download job=%s range=%s format=%s",
                 job_id, request.headers.get("Range") or "full", fmt)
        return web.FileResponse(path, headers=headers)

    spec = (
        ("GET", "/ae_bridge/health", _health),
        ("POST", "/ae_bridge/assets", _post_asset),
        ("POST", "/ae_bridge/assets/begin", _begin_upload),
        ("POST", "/ae_bridge/assets/chunk", _upload_chunk),
        ("POST", "/ae_bridge/assets/finish", _finish_upload),
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
