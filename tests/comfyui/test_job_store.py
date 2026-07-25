"""Job store tests: creation, assets, TTL expiry, result registration."""

import os
import time

import pytest

from comfyui.ae_bridge import job_store


@pytest.fixture(autouse=True)
def clean_jobs():
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])
    yield
    for j in job_store.list_jobs():
        job_store.cleanup_job(j["job_id"])


def test_create_and_get_job():
    entry = job_store.create_job("job-1", {"width": 64, "height": 32})
    assert entry["metadata"]["width"] == 64
    fetched = job_store.get_job("job-1")
    assert fetched is entry
    assert os.path.isdir(entry["dir"])


def test_invalid_job_id_rejected():
    for bad in ("", "../x", "a/b", None):
        with pytest.raises(ValueError):
            job_store.create_job(bad, {})


def test_store_and_get_asset(tmp_path):
    job_store.create_job("job-2", {})
    f = tmp_path / "main.png"
    f.write_bytes(b"fake")
    job_store.store_asset("job-2", "main", str(f))
    assert job_store.get_asset("job-2", "main") == str(f)


def test_get_asset_unknown_job():
    with pytest.raises(KeyError):
        job_store.get_asset("nope", "main")


def test_get_asset_missing_asset_id(tmp_path):
    job_store.create_job("job-3", {})
    with pytest.raises(KeyError):
        job_store.get_asset("job-3", "mask")


def test_get_asset_deleted_file():
    job_store.create_job("job-4", {})
    job_store.store_asset("job-4", "main", "/nonexistent/main.png")
    with pytest.raises(RuntimeError):
        job_store.get_asset("job-4", "main")


def test_result_roundtrip(tmp_path):
    job_store.create_job("job-5", {})
    f = tmp_path / "result.png"
    f.write_bytes(b"img")
    job_store.set_result("job-5", str(f), {"width": 64, "height": 32})
    result = job_store.get_result("job-5")
    assert result["path"] == str(f)
    assert result["metadata"]["height"] == 32


def test_set_result_unknown_job():
    with pytest.raises(KeyError):
        job_store.set_result("nope", "/tmp/x.png", {})


def test_ttl_expiry_removes_job_and_dir():
    entry = job_store.create_job("job-6", {})
    d = entry["dir"]
    assert os.path.isdir(d)
    entry["created"] = time.time() - job_store.JOB_TTL_SECONDS - 1
    removed = job_store.expire_stale()
    assert removed == 1
    assert job_store.get_job("job-6") is None
    assert not os.path.isdir(d)


def test_recreate_refreshes_ttl_and_metadata():
    first = job_store.create_job("job-7", {"a": 1})
    first["created"] -= 10
    stale_created = first["created"]
    second = job_store.create_job("job-7", {"b": 2})
    assert second is first
    assert second["created"] > stale_created
    assert second["metadata"] == {"b": 2}


def test_cleanup_job():
    entry = job_store.create_job("job-8", {})
    d = entry["dir"]
    assert job_store.cleanup_job("job-8") is True
    assert not os.path.isdir(d)
    assert job_store.cleanup_job("job-8") is False
