/* Node tests for patch_workflow.js. Run: node tests/ae/test_patch_workflow.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Patch = require("../../ae/ComfyUIBridge/js/patch_workflow.js");

const passthroughImage = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../../workflows/passthrough_image.json"), "utf8"));
const passthroughVideo = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../../workflows/passthrough_video.json"), "utf8"));

const manifest = { job_id: "j1", fps: 24, frame_count: 8 };

// --- validate ---
let v = Patch.validateWorkflow(passthroughImage, "image");
assert.deepStrictEqual(v.errors, [], "image passthrough valid for image job");

v = Patch.validateWorkflow(passthroughImage, "video");
assert.ok(v.errors.some(e => e.includes("FromAEVideo")), "image wf rejected for video job");

v = Patch.validateWorkflow(passthroughVideo, "video");
assert.deepStrictEqual(v.errors, [], "video passthrough valid for video job");

v = Patch.validateWorkflow({}, "image");
assert.ok(v.errors.length >= 2, "empty prompt flagged");

// --- patch image workflow ---
let out = Patch.patchWorkflow(passthroughImage, {
    job_id: "job-xyz", asset_id: "main", prompt_text: "neon",
    manifest, image_filename_prefix: "still"
});
let fromNode = out.prompt["1"];
let toNode = out.prompt["2"];
assert.strictEqual(fromNode.inputs.job_id, "job-xyz");
assert.strictEqual(fromNode.inputs.asset_id, "main");
assert.strictEqual(toNode.inputs.job_id, "job-xyz");
assert.strictEqual(toNode.inputs.filename_prefix, "still");
// links untouched
assert.deepStrictEqual(toNode.inputs.image, ["1", 0]);
assert.deepStrictEqual(toNode.inputs.mask, ["1", 1]);
// original not mutated
assert.strictEqual(passthroughImage["1"].inputs.job_id, "");

// --- patch video workflow: meta injected only when scalar ---
out = Patch.patchWorkflow(passthroughVideo, {
    job_id: "job-v", asset_id: "main", manifest,
    video_filename_prefix: "vid"
});
const toVideo = out.prompt["2"];
assert.strictEqual(toVideo.inputs.job_id, "job-v");
assert.strictEqual(toVideo.inputs.filename_prefix, "vid");
// video_meta_json is a LINK to FromAEVideo output 7 -> must stay a link
assert.deepStrictEqual(toVideo.inputs.video_meta_json, ["1", 7]);

// scalar video_meta_json gets replaced
const scalarMeta = JSON.parse(JSON.stringify(passthroughVideo));
scalarMeta["2"].inputs.video_meta_json = "{}";
out = Patch.patchWorkflow(scalarMeta, { job_id: "job-v", manifest });
assert.strictEqual(JSON.parse(out.prompt["2"].inputs.video_meta_json).frame_count, 8);

// --- empty CLIPTextEncode filled ---
const wf = {
    "1": { class_type: "FromAE", inputs: { job_id: "", asset_id: "main" } },
    "2": { class_type: "ToAE", inputs: { job_id: "", filename_prefix: "x", image: ["1", 0] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "already set" } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: ["1", 2] } }
};
out = Patch.patchWorkflow(wf, { job_id: "j", prompt_text: "cyberpunk city" });
assert.strictEqual(out.prompt["3"].inputs.text, "cyberpunk city");
assert.strictEqual(out.prompt["4"].inputs.text, "already set");
assert.deepStrictEqual(out.prompt["5"].inputs.text, ["1", 2]);
assert.strictEqual(out.filled_prompt_nodes, 1);

console.log("test_patch_workflow.js: all assertions passed");
