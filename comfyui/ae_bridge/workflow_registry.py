"""Workflow registry for the AE bridge.

Two sources, merged in `list_workflows()`:

1. Open ComfyUI tabs — the frontend extension (web/ae_bridge.js) publishes
   the open workflow(s) here periodically; entries expire after
   `_EXPIRY_SECONDS` without a refresh, so closing a tab drops them.
2. Saved workflow files — API-format JSON scanned from
   `AE_BRIDGE_WORKFLOW_DIRS` (os.pathsep-separated), defaulting to
   `~/.ae2comfyui/workflows` and the repo `workflows/` directory. Cached for
   `_SAVED_CACHE_SECONDS`. Entry ids are `saved:<filename>`.

Routes (registered on PromptServer):
  GET  /ae_bridge/workflows
  POST /ae_bridge/workflows        (frontend publisher)
  POST /ae_bridge/run_workflow     -> returns the stored prompt for AE to patch
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_WORKFLOWS: Dict[str, Dict[str, Any]] = {}
_EXPIRY_SECONDS = 60.0
_SAVED_CACHE_SECONDS = 10.0
_SAVED_CACHE: Dict[str, Any] = {"ts": 0.0, "entries": {}}

_AE_NODE_TYPES = {
    "from_image": {"FromAE", "AE Bridge: From AE"},
    "to_image": {"ToAE", "AE Bridge: To AE"},
    "from_video": {"FromAEVideo", "AE Bridge: From AE Video"},
    "to_video": {"ToAEVideo", "AE Bridge: To AE Video"},
}


def _flags_from_class_types(class_types) -> Dict[str, bool]:
    types = {str(t) for t in class_types}
    return {
        key: bool(types & names) for key, names in _AE_NODE_TYPES.items()
    }


def _flags_from_prompt(prompt: Any) -> Dict[str, bool]:
    if not isinstance(prompt, dict):
        return {key: False for key in _AE_NODE_TYPES}
    class_types = []
    for node in prompt.values():
        if isinstance(node, dict) and node.get("class_type"):
            class_types.append(node["class_type"])
    return _flags_from_class_types(class_types)


def _media_from_flags(flags: Dict[str, bool]) -> str:
    image = flags.get("from_image") or flags.get("to_image")
    video = flags.get("from_video") or flags.get("to_video")
    if image and video:
        return "both"
    if video:
        return "video"
    if image:
        return "image"
    return "none"


def _public_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    flags = entry.get("flags") or {}
    return {
        "id": entry.get("id"),
        "name": entry.get("name") or entry.get("id"),
        "source": entry.get("source") or "open",
        "has_from_ae": bool(flags.get("from_image") or flags.get("from_video")),
        "has_to_ae": bool(flags.get("to_image") or flags.get("to_video")),
        "media": _media_from_flags(flags),
    }


# --- Open-tab registry -----------------------------------------------------

def store_workflows(workflows: List[Dict[str, Any]]) -> None:
    """Upsert published workflow entries (touching their timestamp)."""
    now = time.time()
    with _LOCK:
        _expire_locked(now)
        for wf in workflows or []:
            if not isinstance(wf, dict) or not wf.get("id"):
                continue
            entry = dict(wf)
            entry["source"] = "open"
            # Prefer flags derived from the actual prompt; fall back to the
            # frontend-computed flags when the graph wasn't serializable.
            prompt = _unwrap_prompt(entry.get("prompt"))
            entry["flags"] = (
                _flags_from_prompt(prompt) if prompt else dict(entry.get("flags") or {})
            )
            entry["_ts"] = now
            _WORKFLOWS[str(entry["id"])] = entry


def _expire_locked(now: float) -> None:
    for wid in list(_WORKFLOWS.keys()):
        if now - _WORKFLOWS[wid].get("_ts", 0) > _EXPIRY_SECONDS:
            _WORKFLOWS.pop(wid, None)


def _unwrap_prompt(prompt: Any) -> Optional[Dict[str, Any]]:
    """Accept API prompt dicts and graphToPrompt wrappers."""
    if isinstance(prompt, dict):
        if isinstance(prompt.get("output"), dict):
            return prompt["output"]
        if isinstance(prompt.get("prompt"), dict):
            return prompt["prompt"]
        if prompt:
            return prompt
    return None


# --- Saved workflow scan ---------------------------------------------------

def _saved_dirs() -> List[str]:
    raw = os.environ.get("AE_BRIDGE_WORKFLOW_DIRS", "")
    dirs = [d.strip() for d in raw.split(os.pathsep) if d.strip()]
    if not dirs:
        dirs = [os.path.expanduser("~/.ae2comfyui/workflows")]
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        dirs.append(os.path.join(repo_root, "workflows"))
    return dirs


def _scan_saved_locked(now: float) -> Dict[str, Dict[str, Any]]:
    if now - _SAVED_CACHE["ts"] < _SAVED_CACHE_SECONDS:
        return _SAVED_CACHE["entries"]
    entries: Dict[str, Dict[str, Any]] = {}
    for directory in _saved_dirs():
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.lower().endswith(".json"):
                continue
            path = os.path.join(directory, name)
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                continue
            prompt = _unwrap_prompt(data)
            if not _looks_like_api_prompt(prompt):
                continue
            wid = f"saved:{name}"
            entries[wid] = {
                "id": wid,
                "name": os.path.splitext(name)[0],
                "source": "saved",
                "prompt": prompt,
                "flags": _flags_from_prompt(prompt),
                "path": path,
            }
    _SAVED_CACHE["ts"] = now
    _SAVED_CACHE["entries"] = entries
    return entries


def _looks_like_api_prompt(prompt: Any) -> bool:
    if not isinstance(prompt, dict) or not prompt:
        return False
    for node in prompt.values():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
            return False
    return True


# --- Public API ------------------------------------------------------------

def list_workflows() -> List[Dict[str, Any]]:
    now = time.time()
    with _LOCK:
        _expire_locked(now)
        open_entries = [_public_entry(v) for v in _WORKFLOWS.values()]
        saved_entries = [
            _public_entry(v) for v in _scan_saved_locked(now).values()
        ]
    return open_entries + saved_entries


def get_workflow(workflow_id: str) -> Optional[Dict[str, Any]]:
    wid = str(workflow_id or "")
    now = time.time()
    with _LOCK:
        _expire_locked(now)
        if wid in _WORKFLOWS:
            return _WORKFLOWS[wid]
        return _scan_saved_locked(now).get(wid)


def try_submit_workflow(
    workflow_id: str, client_id: Optional[str] = None
) -> Dict[str, Any]:
    """Resolve `workflow_id` and hand the prompt back for AE to patch + POST.

    Backend submission via PromptServer internals is version-dependent; AE
    posting /prompt itself is reliable and uses no undocumented APIs.
    """
    wf = get_workflow(workflow_id)
    if not wf:
        return {"ok": False, "error": "workflow not found"}
    prompt = _unwrap_prompt(wf.get("prompt"))
    if not prompt:
        return {"ok": False, "error": "workflow has no stored prompt"}
    cid = client_id or uuid.uuid4().hex
    return {"ok": True, "submitted": False, "client_id": cid, "prompt": prompt}


# --- Route registration ----------------------------------------------------

def add_routes(server: Any) -> bool:
    """Register workflow routes on a PromptServer instance."""
    try:
        from aiohttp import web
    except Exception:
        return False

    routes = getattr(server, "routes", None)
    if routes is None:
        return False

    async def _get_workflows(_request: Any) -> Any:
        return web.json_response({"ok": True, "workflows": list_workflows()})

    async def _post_workflows(request: Any) -> Any:
        try:
            data = await request.json()
        except Exception:
            data = {}
        store_workflows((data or {}).get("workflows") or [])
        return web.json_response({"ok": True, "count": len(list_workflows())})

    async def _run_workflow(request: Any) -> Any:
        try:
            data = await request.json()
        except Exception:
            data = {}
        result = try_submit_workflow(
            (data or {}).get("workflow_id") or "",
            (data or {}).get("client_id"),
        )
        status = 200 if result.get("ok") else 404
        return web.json_response(result, status=status)

    spec = (
        ("GET", "/ae_bridge/workflows", _get_workflows),
        ("POST", "/ae_bridge/workflows", _post_workflows),
        ("POST", "/ae_bridge/run_workflow", _run_workflow),
    )
    for method, path, handler in spec:
        try:
            getattr(routes, "add_" + method.lower())(path, handler)
        except Exception:
            try:
                getattr(routes, method.lower())(path)(handler)
            except Exception:
                pass
    return True
