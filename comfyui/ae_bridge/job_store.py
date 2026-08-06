"""In-memory job registry for the AE bridge.

AE uploads assets (main image/video + optional mask) together with a
job_manifest.json before queueing a workflow. FromAE/FromAEVideo read the
assets; ToAE/ToAEVideo register the result for the panel to download.

Storage is in-memory only — a ComfyUI restart clears all jobs. Entries expire
JOB_TTL_SECONDS after creation; expiry also deletes the job staging directory.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from typing import Any, Dict, List, Optional

JOB_TTL_SECONDS = 3600.0

_LOCK = threading.RLock()
_JOBS: Dict[str, Dict[str, Any]] = {}


def _staging_root() -> str:
    """Job staging root: ComfyUI temp dir when available, else system temp."""
    try:
        import folder_paths  # type: ignore  # only inside ComfyUI
        root = os.path.join(folder_paths.get_temp_directory(), "ae_bridge")
    except Exception:
        import tempfile
        root = os.path.join(tempfile.gettempdir(), "ae_bridge")
    os.makedirs(root, exist_ok=True)
    return root


def job_dir(job_id: str) -> str:
    """Absolute staging directory for a job. Caller must have validated job_id."""
    return os.path.join(_staging_root(), str(job_id))


def _valid_job_id(job_id: str) -> bool:
    jid = str(job_id or "")
    return bool(jid) and os.sep not in jid and "/" not in jid and ".." not in jid


def module_identity() -> str:
    """Diagnostic identity for this job-store module (file path when known).

    Exposed via /ae_bridge/health so an install-level "two job stores"
    hypothesis can be confirmed or ruled out on the user's ComfyUI before any
    structural change is considered.
    """
    try:
        return os.path.abspath(__file__)
    except Exception:
        return "<module file unknown>"


def _known_job_ids() -> List[str]:
    with _LOCK:
        return sorted(str(j) for j in _JOBS.keys())


def _expire_locked(now: float) -> None:
    for jid in list(_JOBS.keys()):
        if now - _JOBS[jid].get("created", 0) > JOB_TTL_SECONDS:
            entry = _JOBS.pop(jid)
            shutil.rmtree(str(entry.get("dir") or ""), ignore_errors=True)


def expire_stale(now: Optional[float] = None) -> int:
    """Expire stale jobs; returns the number removed. Safe to call periodically."""
    with _LOCK:
        before = len(_JOBS)
        _expire_locked(time.time() if now is None else now)
        return before - len(_JOBS)


def create_job(job_id: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Create (or reuse) a job entry and its staging directory."""
    if not _valid_job_id(job_id):
        raise ValueError(f"invalid job_id: {job_id!r}")
    now = time.time()
    with _LOCK:
        _expire_locked(now)
        entry = _JOBS.get(str(job_id))
        if entry is None:
            entry = {
                "job_id": str(job_id),
                "metadata": dict(metadata or {}),
                "assets": {},
                "result": None,
                "created": now,
                "dir": job_dir(job_id),
            }
            _JOBS[str(job_id)] = entry
        else:
            # New assets for the same run: refresh TTL and merge metadata.
            entry["created"] = now
            if metadata:
                entry["metadata"] = dict(metadata)
    os.makedirs(entry["dir"], exist_ok=True)
    return entry


def store_asset(job_id: str, asset_id: str, path: str) -> Dict[str, Any]:
    """Register an asset file (already written under the job dir) for a job."""
    with _LOCK:
        entry = _JOBS.get(str(job_id))
        if entry is None:
            raise KeyError(f"unknown job_id: {job_id!r}")
        entry["assets"][str(asset_id)] = str(path)
        return entry


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        _expire_locked(time.time())
        return _JOBS.get(str(job_id))


def get_asset(job_id: str, asset_id: str) -> str:
    """Absolute path of an asset. Raises KeyError/RuntimeError when missing.

    Errors carry diagnostics (module identity + known job ids) so a missing
    asset is distinguishable from a stale/duplicated job store.
    """
    diag = f"(job store module: {module_identity()}, known jobs: {_known_job_ids()})"
    entry = get_job(job_id)
    if entry is None:
        raise KeyError(f"unknown or expired job_id: {job_id!r} {diag}")
    path = entry["assets"].get(str(asset_id))
    if not path:
        raise KeyError(f"job {job_id!r} has no asset {asset_id!r} {diag}")
    if not os.path.isfile(path):
        raise RuntimeError(
            f"asset file missing on disk: {path!r} "
            f"(job store module: {module_identity()})"
        )
    return path


def set_result(
    job_id: str,
    result_path: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Register the ToAE/ToAEVideo output for panel download."""
    entry = get_job(job_id)
    if entry is None:
        raise KeyError(f"unknown or expired job_id: {job_id!r}")
    _pending_uploads(entry).clear()
    entry["result"] = {"path": str(result_path), "metadata": dict(metadata or {})}
    return entry


def get_result(job_id: str) -> Optional[Dict[str, Any]]:
    entry = get_job(job_id)
    return None if entry is None else entry.get("result")


def list_jobs() -> List[Dict[str, Any]]:
    with _LOCK:
        _expire_locked(time.time())
        return [
            {
                "job_id": j["job_id"],
                "assets": sorted(j["assets"].keys()),
                "has_result": j.get("result") is not None,
                "created": j["created"],
            }
            for j in _JOBS.values()
        ]


def cleanup_job(job_id: str) -> bool:
    """Remove a job and its staging directory. Returns True when it existed."""
    with _LOCK:
        entry = _JOBS.pop(str(job_id), None)
    if entry is None:
        return False
    shutil.rmtree(str(entry.get("dir") or ""), ignore_errors=True)
    return True


# --- chunked upload state ---------------------------------------------------
#
# A job can have several in-flight chunked uploads (main + mask) in parallel.
# Each is keyed by asset_id and carries the .part path, the expected size from
# the begin call, the high-water mark, and merged byte ranges written so far.


def begin_upload(
    job_id: str, asset_id: str, part_path: str, size: int
) -> Dict[str, Any]:
    """Register a chunked upload before the first chunk arrives.

    Re-beginning an upload resets its state (idempotent retry).
    """
    with _LOCK:
        entry = _JOBS.get(str(job_id))
        if entry is None:
            raise KeyError(f"unknown job_id: {job_id!r}")
        state = {
            "asset_id": str(asset_id),
            "part_path": str(part_path),
            "size": int(size),
            "written": 0,
            "ranges": [],
        }
        _pending_uploads(entry)[str(asset_id)] = state
        return dict(state)


def get_upload(job_id: str, asset_id: str) -> Optional[Dict[str, Any]]:
    """Return the upload state, or None when no begin call was made."""
    with _LOCK:
        entry = _JOBS.get(str(job_id))
        if entry is None:
            return None
        state = _pending_uploads(entry).get(str(asset_id))
        return dict(state) if state else None


def mark_upload_written(job_id: str, asset_id: str, offset: int, length: int) -> Dict[str, Any]:
    """Record a written chunk and merge its byte range with prior chunks."""
    with _LOCK:
        entry = _JOBS.get(str(job_id))
        if entry is None:
            raise KeyError(f"unknown job_id: {job_id!r}")
        state = _pending_uploads(entry).get(str(asset_id))
        if state is None:
            raise KeyError(f"no upload in progress for asset {asset_id!r}")
        start = int(offset)
        end = start + int(length)
        ranges = list(state.get("ranges") or [])
        ranges.append((start, end))
        ranges.sort()
        merged = []
        for current_start, current_end in ranges:
            if merged and current_start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], current_end))
            else:
                merged.append((current_start, current_end))
        state["ranges"] = merged
        state["written"] = max(int(state.get("written") or 0), end)
        return dict(state)


def finish_upload(job_id: str, asset_id: str, final_path: str) -> Dict[str, Any]:
    """Promote a completed .part upload to a registered asset.

    The caller must already have verified byte counts. Raises KeyError when
    there is no in-flight upload for the asset.
    """
    with _LOCK:
        entry = _JOBS.get(str(job_id))
        if entry is None:
            raise KeyError(f"unknown job_id: {job_id!r}")
        state = _pending_uploads(entry).pop(str(asset_id), None)
        if state is None:
            raise KeyError(f"no upload in progress for asset {asset_id!r}")
        entry["assets"][str(asset_id)] = str(final_path)
        return dict(state)


def _pending_uploads(entry: Dict[str, Any]) -> dict:
    return entry.setdefault("_uploads", {})
