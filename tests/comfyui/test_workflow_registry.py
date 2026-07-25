"""Workflow registry tests: open-tab store/expiry, saved scan, media flags."""

import json
import os
import time

import pytest

from comfyui.ae_bridge import workflow_registry as reg


@pytest.fixture(autouse=True)
def clean_state(monkeypatch, tmp_path):
    reg._WORKFLOWS.clear()
    reg._SAVED_CACHE["ts"] = 0.0
    reg._SAVED_CACHE["entries"] = {}
    monkeypatch.setenv("AE_BRIDGE_WORKFLOW_DIRS", str(tmp_path))
    yield tmp_path
    reg._WORKFLOWS.clear()
    reg._SAVED_CACHE["ts"] = 0.0
    reg._SAVED_CACHE["entries"] = {}


def image_prompt():
    return {
        "1": {"class_type": "FromAE", "inputs": {"job_id": "", "asset_id": "main"}},
        "2": {"class_type": "ToAE", "inputs": {"job_id": ""}},
    }


def video_prompt():
    return {
        "1": {"class_type": "FromAEVideo", "inputs": {"job_id": ""}},
        "2": {"class_type": "ToAEVideo", "inputs": {"job_id": ""}},
        "3": {"class_type": "SaveImage", "inputs": {}},
    }


def test_store_and_list_open_workflow():
    reg.store_workflows([{"id": "wf-1", "name": "Open WF", "prompt": image_prompt()}])
    listing = reg.list_workflows()
    assert len(listing) == 1
    wf = listing[0]
    assert wf["id"] == "wf-1"
    assert wf["source"] == "open"
    assert wf["has_from_ae"] and wf["has_to_ae"]
    assert wf["media"] == "image"


def test_open_workflow_video_media():
    reg.store_workflows([{"id": "wf-2", "prompt": video_prompt()}])
    assert reg.list_workflows()[0]["media"] == "video"


def test_media_both_and_none():
    both = {**image_prompt(), **{f"v{k}": v for k, v in video_prompt().items()}}
    reg.store_workflows([
        {"id": "wf-both", "prompt": both},
        {"id": "wf-none", "prompt": {"9": {"class_type": "SaveImage", "inputs": {}}}},
    ])
    media = {w["id"]: w["media"] for w in reg.list_workflows()}
    assert media["wf-both"] == "both"
    assert media["wf-none"] == "none"


def test_frontend_flags_used_when_prompt_missing():
    reg.store_workflows([{
        "id": "wf-flags", "prompt": None,
        "flags": {"from_image": False, "to_image": False,
                  "from_video": True, "to_video": True},
    }])
    assert reg.list_workflows()[0]["media"] == "video"


def test_open_workflow_expiry():
    reg.store_workflows([{"id": "wf-old", "prompt": image_prompt()}])
    reg._WORKFLOWS["wf-old"]["_ts"] = time.time() - reg._EXPIRY_SECONDS - 1
    assert reg.list_workflows() == []


def test_prompt_wrapper_unwrapped():
    reg.store_workflows([{"id": "wf-wrap", "prompt": {"output": image_prompt()}}])
    result = reg.try_submit_workflow("wf-wrap")
    assert result["ok"]
    assert result["prompt"]["1"]["class_type"] == "FromAE"
    assert result["client_id"]


def test_saved_workflow_scanned(tmp_path):
    (tmp_path / "inpaint.json").write_text(json.dumps(video_prompt()))
    listing = reg.list_workflows()
    saved = [w for w in listing if w["source"] == "saved"]
    assert len(saved) == 1
    assert saved[0]["id"] == "saved:inpaint.json"
    assert saved[0]["name"] == "inpaint"
    assert saved[0]["media"] == "video"
    assert saved[0]["has_from_ae"] and saved[0]["has_to_ae"]


def test_saved_invalid_json_skipped(tmp_path):
    (tmp_path / "broken.json").write_text("{not json")
    (tmp_path / "ui-format.json").write_text(json.dumps({"nodes": [], "links": []}))
    (tmp_path / "readme.txt").write_text("ignored")
    assert reg.list_workflows() == []


def test_saved_cache_ttl(tmp_path):
    (tmp_path / "a.json").write_text(json.dumps(image_prompt()))
    assert len(reg.list_workflows()) == 1
    (tmp_path / "b.json").write_text(json.dumps(image_prompt()))
    # Within cache window: still 1
    assert len(reg.list_workflows()) == 1
    reg._SAVED_CACHE["ts"] -= reg._SAVED_CACHE_SECONDS + 1
    assert len(reg.list_workflows()) == 2


def test_get_and_run_saved_workflow(tmp_path):
    (tmp_path / "run.json").write_text(json.dumps(image_prompt()))
    wf = reg.get_workflow("saved:run.json")
    assert wf is not None
    result = reg.try_submit_workflow("saved:run.json", client_id="cid-1")
    assert result["ok"]
    assert result["client_id"] == "cid-1"
    assert result["prompt"]["2"]["class_type"] == "ToAE"


def test_run_unknown_workflow():
    result = reg.try_submit_workflow("nope")
    assert not result["ok"]
    assert "not found" in result["error"]


def test_default_saved_dir_includes_repo(monkeypatch):
    monkeypatch.delenv("AE_BRIDGE_WORKFLOW_DIRS", raising=False)
    dirs = reg._saved_dirs()
    assert any(d.endswith(os.path.join("workflows")) and "AE2ComfyUI" in d for d in dirs)
    assert any(".ae2comfyui" in d for d in dirs)
