# AE2ComfyUI

After Effects ↔ ComfyUI bridge. Send a full-comp still (PNG) or full-comp
video (MOV ProRes / MP4), plus an optional comp-sized grayscale mask from the
selected AE layer, to a ComfyUI workflow and place the result back in the comp.

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
2. AE: select a layer. The image/video payload is always the full composition.
   A still uses the current comp frame; video uses the complete comp duration.
   The selected layer supplies only the mask and placement target.
3. Panel: pick workflow, prompt, image/video, mask mode, formats, color mode,
   placement. **Queue in ComfyUI**.
4. The panel exports stills directly as PNG or queues video through Adobe
   Media Encoder, uploads to ComfyUI, patches the workflow with the job data, runs
   it, downloads the result, and places it above the selected layer (or top
   of comp) anchored to the export's timeline start.

## AE output templates

Open a composition, then use **Settings > Setup / audit AE templates**. The
panel creates stable bridge-specific aliases where AE exposes a compatible
source template and reports anything that still needs user setup.

| bridge template | use | setup |
|---|---|---|
| `AE2C ProRes 4444` | MOV with alpha | Auto-created from an installed ProRes 4444 template (normally `High Quality with Alpha`) |
| `AE2C ProRes 422 HQ` | MOV, RGB only | Auto-created if AE already exposes a 422 HQ template; otherwise create it once using the instructions below |
| `AE2C H.264 15 Mbps` | MP4 and video masks | Auto-created from AE's built-in 15 Mbps H.264 template (40 or 5 Mbps fallback) |

PNG and JPEG Output Module templates are **not required**. AE-to-ComfyUI
still transport always uses AE's template-independent PNG frame export so it
works on clean AE installations. The `To AE` ComfyUI node controls whether the
returned result is PNG or JPEG.

### One-time ProRes 422 HQ setup (when audit reports it missing)

1. In AE choose **Edit > Templates > Output Module**.
2. Select **New**.
3. Set **Format: QuickTime**.
4. Open **Format Options** and choose **Apple ProRes 422 HQ**.
5. Set **Channels: RGB** and **Depth: Millions of Colors**.
6. Save the template with the exact name `AE2C ProRes 422 HQ`.
7. Run **Setup / audit AE templates** again.

Do not substitute AE's generic `High Quality` template for HQ without
checking it. On AE 26.3 tested here, `High Quality` is ProRes 422 Standard,
while `High Quality with Alpha` is ProRes 4444. If your templates use custom
names, enter those exact names in the four per-format fields in Settings;
the configured name is tried first and the known fallback names follow.

Adobe documents creating and managing Output Module templates under
[rendering and exporting](https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html),
and current AE versions include H.264 Output Module presets at 5, 15, and
40 Mbps ([H.264 export documentation](https://helpx.adobe.com/after-effects/desktop/render-and-export/export-h-264-from-the-after-effects/exporting-h264-from-the-after-effects-render-queue.html)).

## Workflow authoring rules

- Every workflow needs matching `FromAE`/`ToAE` (image) or
  `FromAEVideo`/`ToAEVideo` (video) nodes; the panel validates before queue.
- `job_id` / `asset_id` / `video_meta_json` are injected by the panel — leave
  them at defaults in the graph.
- Prompt: wire the `FromAE` `prompt` STRING output into your text encoders.
  As a fallback, empty `CLIPTextEncode` text fields are filled with the panel
  prompt.
- Masks: the full-comp `IMAGE` and selected-layer `MASK` are separate assets
  with identical comp dimensions (and identical frame count for video). The
  normal **Change AE-masked area** mode inverts the layer's resulting alpha,
  making AE's transparent/cut-out mask region white for ComfyUI. ComfyUI
  receives `0=keep, 1=process/edit`; **Change outside AE mask** uses the
  opposite polarity.
- Connect `From AE: mask` / `From AE Video: mask` to the workflow's actual
  inpaint or mask-conditioning input (for example `InpaintModelConditioning`,
  `VAE Encode (for Inpainting)`, or `Set Latent Noise Mask`). Connecting it
  only to `To AE` changes returned alpha but does not constrain generation;
  the panel rejects that silent no-op when masking is enabled.

## Color modes

| mode | behavior |
|---|---|
| Preserve AE working space (default) | Still uses AE's direct PNG frame output; video requests Output Module Preserve RGB |
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

1. Run **Setup / audit AE templates** and create `AE2C ProRes 422 HQ`
   manually if the audit reports it missing.
2. Confirm the AME main render contains every visible comp layer and that its
   sidecar mask contains only the selected layer's animated masked alpha.
3. Output-module color setting keys (`Preserve RGB`, `Output Profile`) vary
   by AE version; failure is non-fatal and shown as a warning in the panel.
4. CEP fetch to ComfyUI over `http://` on a LAN host (CORS headers are set;
   verify in your CEF build).
