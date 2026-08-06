/* Node test for the shared manifest builder (jsx/manifest.jsx).
   Run: node tests/ae/test_manifest.js */
"use strict";
const assert = require("assert");
const AE2CManifest = require("../../ae/ComfyUIBridge/jsx/manifest.jsx");

const baseCtx = {
    comp_id: 42,
    comp_name: "Shot_010",
    width: 1920, height: 1080, pixel_aspect: 1.0,
    fps: 23.976023976023978,
    duration_seconds: 20.0,
    current_time: 7.5,
    work_area_start: 2.0, work_area_duration: 5.0,
    has_work_area: false,
    selected_layer_index: 4,
    selected_layer_in: 3.0, selected_layer_out: 9.0,
    color: {
        color_engine: "adobe_icc",
        project_working_space: "HDTV (Rec. 709)",
        project_bits_per_channel: 16,
        linearize_working_space: false,
        linear_blending: true
    }
};

const baseOpts = {
    job_id: "job-abc",
    media_type: "image",
    placement: "above_selected_layer",
    mask_mode: "use",
    prompt: "neon glow",
    bridge_color_mode: "preserve_working_space"
};

// Normal AE masking cuts an area out (alpha 0), but ComfyUI edits white (1).
assert.strictEqual(AE2CManifest.maskModeInvertsAlpha("use"), true);
assert.strictEqual(AE2CManifest.maskModeInvertsAlpha("invert"), false);
assert.strictEqual(AE2CManifest.maskModeInvertsAlpha("none"), false);

// --- still image manifest ---
let m = AE2CManifest.buildManifest(baseOpts, baseCtx);
assert.deepStrictEqual(AE2CManifest.validateManifest(m), [], "still manifest valid");
assert.strictEqual(m.media_type, "image");
assert.strictEqual(m.timeline_start_seconds, 7.5, "still anchored at current time");
assert.strictEqual(m.frame_count, 1);
assert.strictEqual(m.range_source, "current_frame");
assert.strictEqual(m.comp_id, 42);
assert.strictEqual(m.selected_layer_index, 4);
assert.strictEqual(m.project_working_space, "HDTV (Rec. 709)");
assert.strictEqual(m.linear_blending, true);
assert.ok(m.timeline_end_seconds_exclusive > m.timeline_start_seconds);

// --- video always uses the full composition, even with a work area ---
let ctxWA = Object.assign({}, baseCtx, { has_work_area: true });
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts, { media_type: "video" }), ctxWA);
assert.deepStrictEqual(AE2CManifest.validateManifest(m), [], "full-comp manifest valid");
assert.strictEqual(m.range_source, "comp");
assert.strictEqual(m.timeline_start_seconds, 0);
assert.strictEqual(m.duration_seconds, 20.0);
assert.strictEqual(m.frame_count, Math.round(20.0 * ctxWA.fps));
assert.strictEqual(m.timeline_end_seconds_exclusive, 20.0);

// --- selected-layer in/out never crops video transport ---
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts, { media_type: "video" }), baseCtx);
assert.strictEqual(m.range_source, "comp");
assert.strictEqual(m.timeline_start_seconds, 0);
assert.strictEqual(m.duration_seconds, 20.0);

// --- video, no layer selected: comp range ---
let ctxNoLayer = Object.assign({}, baseCtx, {
    selected_layer_index: 0, selected_layer_in: 0, selected_layer_out: 0
});
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts, { media_type: "video" }), ctxNoLayer);
assert.strictEqual(m.range_source, "comp");
assert.strictEqual(m.timeline_start_seconds, 0);
assert.strictEqual(m.duration_seconds, 20.0);

// --- enum normalization ---
m = AE2CManifest.buildManifest(
    Object.assign({}, baseOpts, { mask_mode: "bogus", placement: "bogus",
                                  bridge_color_mode: "bogus" }), baseCtx);
assert.strictEqual(m.mask_mode, "none");
assert.strictEqual(m.placement, "above_selected_layer");
assert.strictEqual(m.bridge_color_mode, "preserve_working_space");
assert.strictEqual(m.preserve_rgb, true);

// --- color modes ---
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts, { bridge_color_mode: "srgb" }), baseCtx);
assert.strictEqual(m.output_color_space, "sRGB IEC61966-2.1");
assert.strictEqual(m.preserve_rgb, false);
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts, { bridge_color_mode: "rec709" }), baseCtx);
assert.strictEqual(m.output_color_space, "HDTV (Rec. 709)");
assert.strictEqual(m.preserve_rgb, false);

// --- video format normalization ---
m = AE2CManifest.buildManifest(Object.assign({}, baseOpts,
    { media_type: "video", video_format: "mp4", mov_codec: "prores_422hq" }), ctxWA);
assert.strictEqual(m.video_format, "mp4");
assert.strictEqual(m.mov_codec, "prores_422hq");

// --- validation catches broken manifests ---
assert.ok(AE2CManifest.validateManifest({}).length > 5, "empty manifest fails");
assert.ok(AE2CManifest.validateManifest(
    Object.assign({}, AE2CManifest.buildManifest(baseOpts, baseCtx), { job_id: "" })
).some(e => e.indexOf("job_id") >= 0));

console.log("test_manifest.js: all assertions passed");
