# AE2ComfyUI — Task List

Track per-task status. See `PLAN.md` for detail, `PROTOCOL.md` for contracts.

## Phase 1 — ComfyUI side

- [x] Task 1: Extension skeleton + job store (`__init__.py`, `job_store.py`, tests)
- [x] Task 2: Asset/job routes (`routes.py`, `/ae_bridge/assets|jobs|health`, tests)
- [x] Task 3: Image I/O + `FromAE`/`ToAE` (port image_io, add JPG, tests)
- [x] Task 4: Video I/O + `FromAEVideo`/`ToAEVideo` (port video_io, `AE_BRIDGE_*` env, tests)
- [x] Task 5: Workflow registry + frontend publisher + saved-workflow scan (tests)

## Phase 2 — AE panel

- [x] Task 6: CEP manifest + panel shell + settings tab
- [x] Task 7: `host.jsx` still export + manifest writer
- [x] Task 8: `host.jsx` video export (AME) + result import/placement
- [x] Task 9: `comfy_client.js` + `patch_workflow.js` (Node tests)
- [x] Task 10: Generate-tab orchestration (end-to-end glue, cancel, errors)

## Phase 3 — Polish

- [x] Task 11: Color modes (Preserve working space / sRGB / Rec.709 / data-only)
- [x] Task 12: TTL cleanup, error matrix, installer, docs

## Phase 4 — Video transport + export range fixes

- [x] Task 13: Chunked upload (begin/chunk/finish) + Range result download with
      bounded memory; server verifies size on finish and the panel verifies
      assets via GET /jobs before queueing
- [x] Task 14: Video export renders the comp over the selected layer's in/out
      range (frame-quantized); manifest `range_source="layer_in_out"`
- [x] Task 15: Mask comp built from `comp.duplicate()` pruned to the dependency
      closure; lives until AME finishes/cancels (cleanup in
      `exportVideoStatus`-done and `cancelVideo`, never in export success)
- [x] Task 16: Preflight-first flow: workflow fetch + `validateWorkflow` +
      `validateNodeInputs` (cached `/object_info`, degrades to log-only)
      happen before any AE/AME render or upload; ComfyUI `node_errors`
      formatted readably
- [x] Task 17: Diagnostics — panelLog covers export range, upload/download
      progress, errors; server prints upload/download activity;
      `/ae_bridge/health` exposes job-store module identity; `get_asset` errors
      carry module + known job ids

## Acceptance checklist

- [ ] PNG + alpha still → placed above selected layer
- [ ] JPG opaque still round trip
- [ ] Full-comp MOV ProRes 4444 + selected-layer mask MP4 at 23.976 fps →
      matching geometry/frame count (≤1 frame duration tolerance)
- [ ] Invert mask → inverted ComfyUI MASK
- [ ] Open-tab workflow + saved workflow both listed
- [ ] Preserve-working-space round trip: no visible shift on test chart

## Error matrix (all must surface actionable messages)

- ComfyUI unreachable / down
- AME template missing
- Mask size/frame-count mismatch vs source
- Workflow missing `FromAE`/`ToAE` nodes
- Result frame-count mismatch (hard error, no import)
- ffmpeg/ffprobe absent on ComfyUI host
