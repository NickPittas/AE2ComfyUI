/* AE2ComfyUI job-manifest builder.
 *
 * Pure ES3 logic (no AE API access) so it runs both inside ExtendScript
 * (included by host.jsx via //@include) and in Node tests.
 * Attaches a single global: AE2CManifest.
 */

var AE2CManifest = (function () {
    "use strict";

    var MANIFEST_FIELDS = [
        "job_id", "media_type", "width", "height", "pixel_aspect",
        "fps", "frame_count", "duration_seconds",
        "timeline_start_seconds", "timeline_end_seconds_exclusive",
        "range_source", "video_format", "mov_codec",
        "comp_id", "selected_layer_index", "placement",
        "mask_mode", "prompt",
        "color_engine", "project_working_space", "project_bits_per_channel",
        "linearize_working_space", "linear_blending",
        "bridge_color_mode", "output_color_space", "preserve_rgb"
    ];

    var MASK_MODES = { none: true, use: true, invert: true };
    var COLOR_MODES = {
        preserve_working_space: true, srgb: true, rec709: true, preserve_rgb: true
    };

    // AE's masked/cut-out area is transparent (alpha 0), while ComfyUI edits
    // white mask values (1). Normal mask use therefore inverts layer alpha.
    // The alternate mode changes the opaque/outside area instead.
    function maskModeInvertsAlpha(mode) {
        return mode === "use";
    }

    /* opts: panel choices (job_id, media_type, placement, mask_mode, prompt,
     *   image/video formats, bridge_color_mode)
     * ctx: AE context from getContextJSON (width/height/fps/current_time/
     *   composition duration/selected layer/color)
     */
    function buildManifest(opts, ctx) {
        opts = opts || {};
        ctx = ctx || {};
        var color = ctx.color || {};
        var m = {
            job_id: String(opts.job_id || ""),
            media_type: opts.media_type === "video" ? "video" : "image",
            width: ctx.width || 0,
            height: ctx.height || 0,
            pixel_aspect: ctx.pixel_aspect || 1.0,
            fps: ctx.fps || 0,
            frame_count: 1,
            duration_seconds: 0,
            timeline_start_seconds: 0,
            timeline_end_seconds_exclusive: 0,
            range_source: "current_frame",
            video_format: opts.video_format === "mp4" ? "mp4" : "mov",
            mov_codec: opts.mov_codec === "prores_422hq" ? "prores_422hq" : "prores_4444",
            comp_id: ctx.comp_id || 0,
            selected_layer_index: ctx.selected_layer_index || 0,
            placement: opts.placement === "top_of_comp" ? "top_of_comp" : "above_selected_layer",
            mask_mode: MASK_MODES[opts.mask_mode] ? opts.mask_mode : "none",
            prompt: String(opts.prompt || ""),
            color_engine: color.color_engine || "adobe_icc",
            project_working_space: color.project_working_space || "",
            project_bits_per_channel: color.project_bits_per_channel || 16,
            linearize_working_space: !!color.linearize_working_space,
            linear_blending: !!color.linear_blending,
            bridge_color_mode: COLOR_MODES[opts.bridge_color_mode] ? opts.bridge_color_mode : "preserve_working_space",
            output_color_space: opts.bridge_color_mode === "srgb" ? "sRGB IEC61966-2.1"
                : opts.bridge_color_mode === "rec709" ? "HDTV (Rec. 709)" : "",
            preserve_rgb: opts.bridge_color_mode !== "srgb" && opts.bridge_color_mode !== "rec709"
        };

        if (m.media_type === "image") {
            m.timeline_start_seconds = ctx.current_time || 0;
            m.timeline_end_seconds_exclusive = m.timeline_start_seconds + (1 / m.fps);
            m.frame_count = 1;
            m.duration_seconds = 1 / m.fps;
        } else {
            // Video transport is always the full composition. The selected
            // layer identifies only the mask source and placement target; it
            // must never crop the image/video payload or its time range.
            var start = 0;
            var dur = ctx.duration_seconds;
            m.range_source = "comp";
            m.timeline_start_seconds = start;
            m.timeline_end_seconds_exclusive = start + dur;
            m.duration_seconds = dur;
            m.frame_count = Math.max(1, Math.round(dur * m.fps));
        }
        return m;
    }

    function validateManifest(m) {
        var errors = [];
        for (var i = 0; i < MANIFEST_FIELDS.length; i++) {
            if (!(MANIFEST_FIELDS[i] in m)) {
                errors.push("missing field: " + MANIFEST_FIELDS[i]);
            }
        }
        if (!m.job_id) errors.push("job_id is empty");
        if (m.media_type !== "image" && m.media_type !== "video") {
            errors.push("bad media_type: " + m.media_type);
        }
        if (!MASK_MODES[m.mask_mode]) errors.push("bad mask_mode: " + m.mask_mode);
        if (!COLOR_MODES[m.bridge_color_mode]) {
            errors.push("bad bridge_color_mode: " + m.bridge_color_mode);
        }
        if (m.media_type === "video" && m.frame_count < 1) {
            errors.push("video frame_count < 1");
        }
        if (m.timeline_end_seconds_exclusive <= m.timeline_start_seconds) {
            errors.push("empty timeline range");
        }
        return errors;
    }

    return {
        MANIFEST_FIELDS: MANIFEST_FIELDS,
        buildManifest: buildManifest,
        validateManifest: validateManifest,
        maskModeInvertsAlpha: maskModeInvertsAlpha
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = AE2CManifest;
}
