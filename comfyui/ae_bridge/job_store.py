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
    """Absolute path of an asset. Raises KeyError/RuntimeError when missing."""
    entry = get_job(job_id)
    if entry is None:
        raise KeyError(f"unknown or expired job_id: {job_id!r}")
    path = entry["assets"].get(str(asset_id))
    if not path:
        raise KeyError(f"job {job_id!r} has no asset {asset_id!r}")
    if not os.path.isfile(path):
        raise RuntimeError(f"asset file missing on disk: {path!r}")
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
