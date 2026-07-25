# AE2ComfyUI

After Effects ↔ ComfyUI bridge. Send a still (PNG/JPG + alpha) or a video
(MOV ProRes / MP4 + grayscale mask MP4) from the selected AE layer to a
ComfyUI workflow, and get the result back into the comp at the exact timeline
position (work-area aware).

Architecture, contracts, and task tracking live in `PLAN.md`, `PROTOCOL.md`,
and `TASKS.md`. The ComfyUI side is ported from the proven
[NukeToComfyUI](https://github.com/NickPittas/NukeToComfyUI) bridge.

## Components

```text
ae/ComfyUIBridge/          CEP panel (ExtendScript + panel JS)
comfyui/ae_bridge/         ComfyUI custom nodes + /ae_bridge/* routes
workflows/                 Saved API workflows (shown in the panel dropdown)
tests/                     pytest (ComfyUI) + Node tests (panel JS)
tools/install.py           Installer (symlinks both sides)
```

## Install

```bash
python3 tools/install.py --comfyui /path/to/ComfyUI --enable-debug
```

- `--comfyui`: ComfyUI root (or set `COMFYUI_ROOT`). Links
  `comfyui/ae_bridge` into `custom_nodes/`.
- CEP panel is linked into the per-OS CEP `extensions/` dir
  (`--cep-dir` to override, `--copy` to copy instead of symlink).
- `--enable-debug` (macOS): sets `PlayerDebugMode=1` so unsigned panels load.
  On Windows set the equivalent registry key.
- `--dry-run` previews every action.

Restart ComfyUI and AE. In AE: **Window > Extensions > AE2ComfyUI**.

## Use

1. ComfyUI: open a workflow containing `AE Bridge: From AE` → … →
   `AE Bridge: To AE` (or the `Video` variants). The bundled
   `workflows/passthrough_image.json` / `passthrough_video.json` are
   no-model smoke tests; drop your own API-format workflows into `workflows/`
   or `~/.ae2comfyui/workflows/`.
2. AE: select a layer. Still = current frame; video = work area (else layer
   in/out, else comp range).
3. Panel: pick workflow, prompt, image/video, mask mode, formats, color mode,
   placement. **Queue in ComfyUI**.
4. The panel exports via Render Queue (stills) or Adobe Media Encoder
   (video), uploads to ComfyUI, patches the workflow with the job data, runs
   it, downloads the result, and places it above the selected layer (or top
   of comp) anchored to the export's timeline start.

## Workflow authoring rules

- Every workflow needs matching `FromAE`/`ToAE` (image) or
  `FromAEVideo`/`ToAEVideo` (video) nodes; the panel validates before queue.
- `job_id` / `asset_id` / `video_meta_json` are injected by the panel — leave
  them at defaults in the graph.
- Prompt: wire the `FromAE` `prompt` STRING output into your text encoders.
  As a fallback, empty `CLIPTextEncode` text fields are filled with the panel
  prompt.
- Masks: ComfyUI `MASK` convention (`0=keep, 1=masked`). AE alpha is
  converted automatically; `Invert` flips it AE-side before export.

## Color modes

| mode | behavior |
|---|---|
| Preserve AE working space (default) | Output module Preserve RGB; result treated as working-space values |
| sRGB transport | Export converts to sRGB; PNG result embeds sRGB ICC |
| Rec.709 transport | Export converts to Rec.709 |
| Preserve RGB (data only) | Raw numbers, no transforms — mattes/utility maps |

Project color state (engine, working space, bit depth, linear flags) is
recorded in every job manifest. Video results are re-tagged with the source's
color metadata (BT.709 fallback) by `ToAEVideo`.

## Requirements

- After Effects 2022+ with Adobe Media Encoder (video export).
- ComfyUI (localhost or trusted LAN) with `ffmpeg`/`ffprobe` on its host.
- ComfyUI-side Python deps are ComfyUI-standard: `requests`, `Pillow`,
  `numpy`, `torch`.

## Development

```bash
# Python tests (venv with pytest, numpy, pillow, aiohttp, torch)
python -m pytest tests/comfyui/

# Panel JS tests
for t in tests/ae/test_*.js; do node "$t"; done

# Syntax checks
python -m compileall comfyui/ae_bridge
node --check ae/ComfyUIBridge/js/panel.js
```

Jobs are staged under ComfyUI's temp dir (`ae_bridge/<job_id>/`) and expire
after 1 hour (`JOB_TTL_SECONDS`), including their files.

### Manual verification points (need a live AE + AME + ComfyUI)

These are environment-dependent and can't be covered by automated tests:

1. AME template names for ProRes 4444/422 HQ and H.264 on your AE version
   (set overrides in Settings if auto-detection misses).
2. Solo-state timing: the main video export solos the selected layer before
   `queueInAME` and restores right after; if AME renders from live project
   state, the export may include other layers — switch to a duplicate-comp
   export if observed.
3. Output-module color setting keys (`Preserve RGB`, `Output Profile`) vary
   by AE version; failure is non-fatal and shown as a warning in the panel.
4. CEP fetch to ComfyUI over `http://` on a LAN host (CORS headers are set;
   verify in your CEF build).
