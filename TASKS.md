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

## Acceptance checklist

- [ ] PNG + alpha still → placed above selected layer
- [ ] JPG opaque still round trip
- [ ] MOV ProRes 4444 + mask MP4; work area 23.976 fps → result starts exactly
      at work-area start (≤1 frame duration tolerance)
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
