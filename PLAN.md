# AE ↔ ComfyUI Bridge — Implementation Plan

## Goal

After Effects CEP panel + ComfyUI custom nodes that send a full-comp still
(PNG) or full-comp video (MOV ProRes / MP4), plus an optional comp-sized mask
from the selected layer, from AE to ComfyUI, run a
user-selected workflow with a prompt and mask mode, and return the result into
the AE comp at the correct timeline position.

Prototype: `NickPittas/NukeToComfyUI`. The ComfyUI side ports its proven
patterns (image_io, video_io, workflow registry, frontend publisher, node
structure). The Nuke host-side code is replaced by a CEP + ExtendScript AE
panel. Unlike Nuke's pull model, AE **uploads assets first**; results are
pulled back by the panel. No HTTP server runs inside AE.

## Architecture

```text
AE CEP Panel (ExtendScript + JS)
  ├── Export source (still or video) + mask to staging folder (Render Queue / AME)
  ├── Write job_manifest.json (job_id, geometry, fps, timeline anchor, color)
  ├── Upload assets to ComfyUI  ──►  POST /ae_bridge/assets
  ├── Fetch workflow (open tabs + saved files)  ──►  GET /ae_bridge/workflows
  ├── Patch prompt: inject job_id, prompt text, metadata into FromAE nodes
  ├── POST /prompt → ComfyUI queue
  └── Poll /history → download result → import into comp at timeline anchor

ComfyUI custom_nodes/ae_bridge/
  ├── nodes.py              FromAE, ToAE, FromAEVideo, ToAEVideo
  ├── image_io.py           PNG/JPG ↔ tensor
  ├── video_io.py           MOV/MP4 ffmpeg decode/encode
  ├── job_store.py          In-memory job registry: assets + metadata per job_id
  ├── workflow_registry.py  Open-tab publisher + saved-file scanner
  ├── routes.py             /ae_bridge/* aiohttp routes
  └── web/ae_bridge.js      Frontend publisher of open workflows
```

## Global constraints

- AE panel: CEP + ExtendScript only (no UXP in v1).
- ComfyUI on localhost or trusted LAN; plain HTTP only.
- Video export requires Adobe Media Encoder.
- ComfyUI-side deps: `requests`, `Pillow`, `numpy`, `torch` (standard in
  ComfyUI) + system `ffmpeg`/`ffprobe`.
- AE side: ExtendScript stdlib; CEP panel uses Node.js `fetch`/`FormData`.
- No AE-side HTTP server. AE is the client; ComfyUI hosts all routes.
- Node names: `FromAE`, `ToAE`, `FromAEVideo`, `ToAEVideo`; category
  `AEBridge`; routes under `/ae_bridge/`.
- Validate before queue: workflow contains matching AE nodes; asset/mask frame
  counts match; AME output duration matches.
- Validate before import: result dimensions, frame count, FPS vs manifest.
  Frame-count mismatch is a hard error — never silently drift in time.

## Node contracts

### `FromAE`
Inputs: `job_id`, `asset_id`
Outputs: `IMAGE`, `MASK`, `STRING prompt`, `INT width`, `INT height`

### `ToAE` (OUTPUT_NODE)
Inputs: `image`, optional `mask`, `job_id`, `filename_prefix`, `format: png|jpg`
Output: `IMAGE` passthrough. PNG embeds mask as alpha when connected.

### `FromAEVideo`
Inputs: `job_id`, `asset_id`
Outputs: `IMAGE` batch, `MASK` batch, `INT width`, `INT height`,
`INT frame_count`, `FLOAT fps`, `FLOAT duration_seconds`,
`STRING video_meta_json`

### `ToAEVideo` (OUTPUT_NODE)
Inputs: `image` batch, optional `mask`, `job_id`, `video_meta_json`,
`filename_prefix`, `format_override: auto|mp4|mov`,
`mov_codec_override: auto|prores_422hq|prores_4444`
Output: `IMAGE` passthrough. Optional separate mask MP4 when mask connected.
Result is registered in the job store for panel download.

## Mask convention

ComfyUI MASK: `0 = keep, 1 = process/edit`. The separate carrier is the
selected layer's masked alpha rendered white-on-black at full-comp geometry.
Mask modes in the panel: `none | use | invert`. Inversion happens AE-side.

## Timeline placement

- **Still**: export at current comp time; import result at that same captured
  time (`timeline_start_seconds`), placed above the selected layer or at
  index 1.
- **Video**: always export the full composition interval `[0, compDuration)`;
  the selected layer affects only mask generation and placement.
- Import uses the manifest anchor captured at export time, never the playhead
  at completion time.

## Color

Two AE color engines (per Adobe docs):

1. **Adobe color managed** (ICC): scripting exposes
   `app.project.workingSpace`, `app.project.listColorProfiles()`.
2. **OCIO color managed**: `ACE 2` config, custom configs supported.

Panel color modes:

1. `Preserve AE working space` (default) — output module Preserve RGB;
   result treated as working-space values on re-import.
2. `sRGB transport`
3. `Rec.709 transport`
4. `Preserve RGB / data only` — mattes/utility maps, no transforms.

Manifest records: `color_engine`, `project_working_space`,
`project_bits_per_channel`, `linearize_working_space`, `linear_blending`,
`bridge_color_mode`, `output_color_space`, `preserve_rgb`.

Caveats: JPG loses alpha/fidelity (not default); MP4/H.264 is a convenience
format; ProRes MOV is the main video transport; AME/Dynamic Link Rec.709
behavior must be validated manually in Task 8/11.

## File map

| Path | Responsibility |
|---|---|
| `comfyui/ae_bridge/__init__.py` | NODE mappings, WEB_DIRECTORY, routes |
| `comfyui/ae_bridge/nodes.py` | 4 node classes |
| `comfyui/ae_bridge/image_io.py` | PNG/JPG encode/decode ↔ tensors |
| `comfyui/ae_bridge/video_io.py` | ffmpeg video decode/encode, color probes |
| `comfyui/ae_bridge/job_store.py` | Job/asset/metadata storage, TTL |
| `comfyui/ae_bridge/workflow_registry.py` | Open-tab registry + saved scan |
| `comfyui/ae_bridge/routes.py` | aiohttp routes: assets, jobs, workflows |
| `comfyui/ae_bridge/web/ae_bridge.js` | Frontend workflow publisher |
| `ae/ComfyUIBridge/CSXS/manifest.xml` | CEP manifest |
| `ae/ComfyUIBridge/index.html` | Panel UI (Generate / Settings tabs) |
| `ae/ComfyUIBridge/js/panel.js` | UI logic, orchestration |
| `ae/ComfyUIBridge/js/comfy_client.js` | ComfyUI HTTP client |
| `ae/ComfyUIBridge/js/patch_workflow.js` | Workflow patcher |
| `ae/ComfyUIBridge/js/settings.js` | localStorage settings |
| `ae/ComfyUIBridge/jsx/host.jsx` | ExtendScript export/import/manifest |
| `tests/comfyui/` | pytest suites |
| `tests/ae/` | Node tests for panel JS; JSX fixtures |
| `tools/install.py` | Links panel + custom_nodes, health check |
| `workflows/` | Saved workflow folder (default scan target) |

## Tasks

### Task 1: ComfyUI extension skeleton + job store
`__init__.py` (empty mappings, WEB_DIRECTORY, deferred route registration),
`job_store.py`: thread-safe `{job_id: {metadata, assets, result, created}}`,
`JOB_TTL_SECONDS = 3600`, `create_job`, `store_asset`, `get_asset`, `get_job`,
`set_result`, staging under
`folder_paths.get_temp_directory()/ae_bridge/<job_id>/` with standalone
fallback. Test: `tests/comfyui/test_job_store.py`.

### Task 2: Asset upload/download routes
`routes.py` with `add_routes(server)`:
- `POST /ae_bridge/assets` (multipart: `file`, `job_id`, `asset_id`,
  `metadata` JSON)
- `GET /ae_bridge/jobs/{job_id}` → metadata + result info
- `GET /ae_bridge/jobs/{job_id}/result` → streams bytes with `X-AEBridge-*`
  headers
- `GET /ae_bridge/health`
Path-safety checks (reject `..`). Test: `tests/comfyui/test_routes.py`.

### Task 3: Image I/O + FromAE / ToAE
Port `image_io.py` from Nuke project, drop EXR, add JPG.
`decode_image_bytes(body, fmt) -> (image, mask, w, h)`;
`encode_image_bytes(image, fmt: png|jpg, mask|None) -> (bytes, content_type)`.
`IS_CHANGED = uuid` on FromAE. Tests: `test_image_io.py`, `test_nodes.py`.

### Task 4: Video I/O + FromAEVideo / ToAEVideo
Port `video_io.py` (env prefix `AE_BRIDGE_*`, rgb48le default, bt709 fallback
tags, setparams tagging). Nodes read manifest from job store, validate frame
counts, output width/height/frame_count/fps/duration. Test:
`test_video_io.py` (skip when ffmpeg missing).

### Task 5: Workflow registry
Port `workflow_registry.py` + `web/nuke_bridge.js` → `ae_bridge.js`.
Extend with saved-workflow scanner (`AE_BRIDGE_WORKFLOW_DIRS`, default
`~/.ae2comfyui/workflows/` + repo `workflows/`, id `saved:<filename>`, 10s
cache, API-format JSON only) and media detection (`image|video|both`).
Routes: `GET/POST /ae_bridge/workflows`, `POST /ae_bridge/run_workflow`
(returns prompt; AE posts `/prompt` itself — proven Nuke pattern).
Test: `test_workflow_registry.py`.

### Task 6: AE CEP panel shell + settings
`CSXS/manifest.xml` (CEP 10+, AEFT, AE 2022+, `--enable-nodejs`),
`index.html` Generate/Settings tabs, `settings.js` (localStorage `ae2c.*`:
host, port, stagingFolder, resultFolder, workflowDirs, ameTemplateNames),
connection status via `/ae_bridge/health`.

### Task 7: ExtendScript still export + manifest
`jsx/host.jsx`: `AE2C.getContextJSON()` (comp id, selected layer, time, work
area, fps, geometry, pixelAspect, workingSpace, linearizeWorkingSpace,
linearBlending, bitsPerChannel), `AE2C.exportStill(optsJSON)` (temp render
queue item → PNG/JPG; mask PNG via temp comp when mask mode != none; writes
`job_manifest.json`). Strict `{ok:false, error}` returns; try/finally cleanup
of temp items. Test: `tests/ae/test_manifest.jsx` schema validation.

Manifest fields (exact):
```json
{
  "job_id": "", "media_type": "image|video",
  "width": 0, "height": 0, "pixel_aspect": 1.0,
  "fps": 0, "frame_count": 1, "duration_seconds": 0,
  "timeline_start_seconds": 0, "timeline_end_seconds_exclusive": 0,
  "range_source": "comp|current_frame",
  "video_format": "mov|mp4",
  "mov_codec": "prores_4444|prores_422hq",
  "comp_id": 0, "selected_layer_index": 0,
  "placement": "above_selected_layer|top_of_comp",
  "mask_mode": "none|use|invert",
  "prompt": "",
  "color_engine": "adobe_icc|ocio",
  "project_working_space": "", "project_bits_per_channel": 16,
  "linearize_working_space": false, "linear_blending": false,
  "bridge_color_mode": "preserve_working_space|srgb|rec709|preserve_rgb",
  "output_color_space": "", "preserve_rgb": true
}
```

### Task 8: Video export via AME + result import
`AE2C.exportVideo(optsJSON)`: full composition through Render Queue + AME
template (MOV ProRes 4444 or MP4); second full-comp-sized item for the selected
layer mask MP4; `queueInAME()`; poll files.
`AE2C.importResult(optsJSON)`: importFile; add layer at manifest
`timeline_start_seconds`; set in/out from returned frame count/fps; above
selected layer or index 1; label "AE2C Result"; validate dims/fps/frames vs
manifest → hard error on mismatch. Test: `tests/ae/test_import.jsx`.

### Task 9: ComfyUI client + workflow patching
`comfy_client.js`: health, getWorkflows, uploadAsset, getWorkflow,
queuePrompt, pollHistory, downloadResult (fetch + FormData).
`patch_workflow.js`: deep-copy; inject `job_id`/`asset_id` into
FromAE/FromAEVideo; `job_id`/`filename_prefix`/`video_meta_json` into
ToAE/ToAEVideo; prompt via FromAE prompt STRING output as canonical source;
optional direct CLIPTextEncode patch only when workflow carries a
`prompt_node_id` marker. Test: `tests/ae/test_patch_workflow.js` (Node).

### Task 10: Generate-tab orchestration
Queue click: read UI → getContextJSON → build manifest → export → upload
assets → getWorkflow → patch → validate AE nodes → queuePrompt → poll (ws →
history fallback) → downloadResult → importResult at manifest anchor. Cancel
stops monitoring + POSTs `/interrupt`. Disabled Queue while running.
Actionable errors (missing AME template, ffmpeg missing, node mismatch,
result frame mismatch).

### Task 11: Color handling
Panel dropdown `bridge_color_mode`; export sets Preserve RGB or matching
output profile on the output module; `ToAEVideo` re-tags result with source
color metadata (bt709 fallback); PNG embeds ICC for srgb/rec709 modes.
Tests: probe MOV tags; manifest color fields.

### Task 12: Robustness, docs, acceptance
TTL cleanup; error matrix (ComfyUI down, AME template missing, mask size
mismatch, workflow missing AE nodes, frame-count mismatch, ffmpeg absent);
`tools/install.py`; acceptance checklist in `TASKS.md`.

## Acceptance tests

1. PNG + alpha still → placed above selected layer.
2. JPG opaque still round trip.
3. Full-comp MOV ProRes 4444 + selected-layer mask MP4 at 23.976 fps → matching
   geometry/frame count and ≤1-frame duration tolerance.
4. Invert mask → inverted ComfyUI MASK.
5. Open-tab workflow and saved workflow both listed.
6. Preserve-working-space round trip shows no visible shift on a test chart.
