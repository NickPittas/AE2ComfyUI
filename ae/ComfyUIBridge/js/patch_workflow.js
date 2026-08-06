/* AE2ComfyUI workflow patcher.
 *
 * Deep-copies an API-format ComfyUI prompt and injects AE job values into the
 * AE bridge nodes. Link inputs (arrays like ["1", 0]) are never overwritten —
 * only scalar widget values.
 *
 * Prompt text routing: the FromAE `prompt` STRING output is the canonical
 * in-workflow prompt source. Additionally, CLIPTextEncode nodes whose text is
 * an empty string are filled with the panel prompt (documented heuristic).
 */
(function (root) {
    "use strict";

    var FROM_IMAGE = "FromAE";
    var TO_IMAGE = "ToAE";
    var FROM_VIDEO = "FromAEVideo";
    var TO_VIDEO = "ToAEVideo";
    var FROM_TYPES = [FROM_IMAGE, FROM_VIDEO];
    var TO_TYPES = [TO_IMAGE, TO_VIDEO];

    function isLink(value) {
        return Object.prototype.toString.call(value) === "[object Array]";
    }

    function nodeIdsOfType(prompt, types) {
        var ids = [];
        for (var id in prompt) {
            var node = prompt[id];
            if (node && types.indexOf(node.class_type) !== -1) ids.push(id);
        }
        return ids;
    }

    function outputConsumers(prompt, sourceIds, outputIndex) {
        var consumers = [];
        for (var id in prompt) {
            var node = prompt[id];
            if (!node || !node.inputs) continue;
            for (var inputName in node.inputs) {
                var value = node.inputs[inputName];
                if (!isLink(value) || value.length < 2) continue;
                if (sourceIds.indexOf(String(value[0])) !== -1 &&
                        Number(value[1]) === outputIndex) {
                    consumers.push({
                        id: id,
                        class_type: node.class_type || "",
                        input: inputName
                    });
                }
            }
        }
        return consumers;
    }

    function validateWorkflow(prompt, mediaType, maskMode) {
        var errors = [];
        if (!prompt || typeof prompt !== "object") {
            return { errors: ["workflow has no prompt graph"] };
        }
        var fromIds = nodeIdsOfType(prompt, FROM_TYPES);
        var toIds = nodeIdsOfType(prompt, TO_TYPES);
        if (!fromIds.length) errors.push("workflow has no FromAE/FromAEVideo node");
        if (!toIds.length) errors.push("workflow has no ToAE/ToAEVideo node");

        if (mediaType === "video") {
            if (!nodeIdsOfType(prompt, [FROM_VIDEO]).length) {
                errors.push("video job requires a FromAEVideo node");
            }
            if (!nodeIdsOfType(prompt, [TO_VIDEO]).length) {
                errors.push("video job requires a ToAEVideo node");
            }
        } else if (mediaType === "image") {
            if (!nodeIdsOfType(prompt, [FROM_IMAGE]).length) {
                errors.push("image job requires a FromAE node");
            }
            if (!nodeIdsOfType(prompt, [TO_IMAGE]).length) {
                errors.push("image job requires a ToAE node");
            }
        }

        var mediaFromIds = mediaType === "video"
            ? nodeIdsOfType(prompt, [FROM_VIDEO])
            : nodeIdsOfType(prompt, [FROM_IMAGE]);
        var maskConsumers = outputConsumers(prompt, mediaFromIds, 1);
        if (maskMode && maskMode !== "none") {
            var processingMaskConsumers = maskConsumers.filter(function (consumer) {
                return TO_TYPES.indexOf(consumer.class_type) === -1;
            });
            if (!processingMaskConsumers.length) {
                errors.push("mask is enabled, but the From AE mask output is not " +
                    "connected to a processing/inpaint node (a To AE connection alone " +
                    "does not constrain generation)");
            }
        }
        return {
            errors: errors,
            fromIds: fromIds,
            toIds: toIds,
            maskConsumers: maskConsumers
        };
    }

    function _setScalar(inputs, key, value) {
        if (isLink(inputs[key])) return false; // wired input: leave alone
        inputs[key] = value;
        return true;
    }

    /* ctx: {
     *   job_id, asset_id, prompt_text, manifest (object|null),
     *   image_filename_prefix, video_filename_prefix,
     *   video_format, mov_codec
     * } */
    function patchWorkflow(prompt, ctx) {
        var patched = JSON.parse(JSON.stringify(prompt));
        var metaJson = ctx.manifest ? JSON.stringify(ctx.manifest) : "{}";
        var filledPromptNodes = 0;

        for (var id in patched) {
            var node = patched[id];
            if (!node || !node.class_type) continue;
            var inputs = node.inputs = node.inputs || {};

            if (FROM_TYPES.indexOf(node.class_type) !== -1) {
                _setScalar(inputs, "job_id", ctx.job_id);
                _setScalar(inputs, "asset_id", ctx.asset_id || "main");
            } else if (node.class_type === TO_IMAGE) {
                _setScalar(inputs, "job_id", ctx.job_id);
                _setScalar(inputs, "filename_prefix",
                    ctx.image_filename_prefix || "ae_result");
            } else if (node.class_type === TO_VIDEO) {
                _setScalar(inputs, "job_id", ctx.job_id);
                _setScalar(inputs, "filename_prefix",
                    ctx.video_filename_prefix || "ae_video_result");
                _setScalar(inputs, "video_meta_json", metaJson);
                // The AE panel is authoritative for the requested result
                // container/codec. Do not let a saved workflow widget value
                // silently override what the user selected in the panel.
                _setScalar(inputs, "format_override",
                    ctx.video_format || (ctx.manifest && ctx.manifest.video_format) || "auto");
                _setScalar(inputs, "mov_codec_override",
                    ctx.mov_codec || (ctx.manifest && ctx.manifest.mov_codec) || "auto");
            } else if (node.class_type === "CLIPTextEncode" &&
                       ctx.prompt_text && !isLink(inputs.text) &&
                       String(inputs.text || "").trim() === "") {
                inputs.text = ctx.prompt_text;
                filledPromptNodes++;
            }
        }
        return { prompt: patched, filled_prompt_nodes: filledPromptNodes };
    }

    /* Validate that every node's required inputs (from ComfyUI /object_info)
     * are present in the prompt graph. `objectInfo` is keyed by class_type;
     * unknown class types are collected separately (not fatal — the graph
     * may reference nodes the running ComfyUI does not know about, which
     * ComfyUI's own validation reports at queue time). */
    function validateNodeInputs(prompt, objectInfo) {
        var errors = [];
        var unknown = [];
        if (!prompt || typeof prompt !== "object") {
            return { errors: ["workflow has no prompt graph"], unknown: unknown };
        }
        objectInfo = objectInfo || {};
        for (var id in prompt) {
            var node = prompt[id];
            if (!node || typeof node !== "object") {
                errors.push("node " + id + " is not an object");
                continue;
            }
            var cls = node.class_type;
            if (!cls) {
                errors.push("node " + id + " has no class_type");
                continue;
            }
            var info = objectInfo[cls];
            if (!info) {
                unknown.push(cls);
                continue;
            }
            var required = (info.input && info.input.required) || {};
            var inputs = node.inputs || {};
            for (var key in required) {
                var present = key in inputs;
                var spec = required[key];
                var inputType = spec && spec.length ? String(spec[0] || "") : "";
                // ComfyUI dynamic/autogrow inputs are flattened in API
                // prompts (for example `values.a`) even though object_info
                // advertises the required container as `values`.
                if (!present && inputType.indexOf("COMFY_AUTOGROW") === 0) {
                    var prefix = key + ".";
                    for (var inputKey in inputs) {
                        if (inputKey.indexOf(prefix) === 0) {
                            present = true;
                            break;
                        }
                    }
                }
                if (!present) {
                    errors.push("node " + id + " (" + cls + ") missing required input '" + key + "'");
                }
            }
        }
        return { errors: errors, unknown: unknown };
    }

    var API = {
        FROM_TYPES: FROM_TYPES,
        TO_TYPES: TO_TYPES,
        isLink: isLink,
        nodeIdsOfType: nodeIdsOfType,
        outputConsumers: outputConsumers,
        validateWorkflow: validateWorkflow,
        validateNodeInputs: validateNodeInputs,
        patchWorkflow: patchWorkflow
    };
    root.AE2CPatch = API;
    if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
