/* AE2ComfyUI ExtendScript host layer.
 *
 * Loaded by the CEP panel (manifest.xml ScriptPath) and driven via
 * CSInterface.evalScript("AE2C.<fn>(...)"). Every public function returns a
 * JSON string so the panel gets a single parseable result:
 *   success: {"ok": true, ...}
 *   failure: {"ok": false, "error": "..."}
 *
 * All temp render items/comps are cleaned up in finally blocks. Nothing here
 * throws across the evalScript boundary.
 */

// ExtendScript does not guarantee a global JSON object in fresh AE sessions.
// Keep the host bridge self-contained instead of relying on another panel to
// have installed Adobe's JSON global.
#include "json2.js"
#include "manifest.jsx"

var AE2C = (function () {
    "use strict";

    var _manifestLib = (typeof AE2CManifest !== "undefined") ? AE2CManifest : null;
    if (!_manifestLib) {
        // CEP loads this file from the extension dir; manifest.jsx sits next
        // to it. evalFile fallback when the include directive is stripped.
        try {
            var _self = new File($.fileName);
            $.evalFile(new File(_self.parent.fsName + "/manifest.jsx"));
            _manifestLib = AE2CManifest;
        } catch (e) { /* buildManifest will report the missing lib */ }
    }

    // --- helpers -----------------------------------------------------------

    function _err(msg) {
        return JSON.stringify({ ok: false, error: String(msg) });
    }

    function _errorText(error) {
        var text = "unknown ExtendScript error";
        try { text = error.toString(); } catch (ignored) {}
        try {
            if (error.fileName) text += " in " + error.fileName;
            if (error.line) text += " at line " + error.line;
        } catch (ignoredDetails) {}
        return text;
    }

    function _activeComp() {
        var item = app.project.activeItem;
        if (!item || !(item instanceof CompItem)) return null;
        return item;
    }

    function _selectedLayer(comp) {
        var layers = comp.selectedLayers;
        return (layers && layers.length) ? layers[0] : null;
    }

    function _ensureFolder(path) {
        var f = new Folder(path);
        if (!f.exists && !f.create()) {
            throw new Error("cannot create folder: " + path);
        }
        return f;
    }

    function _writeFile(path, text) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("w")) throw new Error("cannot write file: " + path);
        try {
            f.write(text);
        } finally {
            f.close();
        }
    }

    function _readFile(path) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("r")) throw new Error("cannot read file: " + path);
        try {
            return f.read();
        } finally {
            f.close();
        }
    }

    function _join(dir, name) {
        var sep = ($.os.indexOf("Windows") === 0) ? "\\" : "/";
        if (dir.charAt(dir.length - 1) === "/" || dir.charAt(dir.length - 1) === "\\") {
            return dir + name;
        }
        return dir + sep + name;
    }

    // --- binary chunk IO (ES3, File.encoding="binary") ----------------------
    //
    // ExtendScript has no btoa/atob, so base64 encode/decode is hand-rolled.
    // Binary read/write byte fidelity on AE 26 is a flagged live verification
    // point; readFileChunk validates that every read char is a byte (<=255)
    // and returns an explicit actionable error instead of corrupt data.

    var _B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function _b64encode(s) {
        var out = "";
        var i = 0;
        for (; i + 3 <= s.length; i += 3) {
            var n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2);
            out += _B64_CHARS.charAt((n >> 18) & 63) + _B64_CHARS.charAt((n >> 12) & 63) +
                _B64_CHARS.charAt((n >> 6) & 63) + _B64_CHARS.charAt(n & 63);
        }
        var rem = s.length - i;
        if (rem === 1) {
            var n1 = s.charCodeAt(i) << 16;
            out += _B64_CHARS.charAt((n1 >> 18) & 63) + _B64_CHARS.charAt((n1 >> 12) & 63) + "==";
        } else if (rem === 2) {
            var n2 = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8);
            out += _B64_CHARS.charAt((n2 >> 18) & 63) + _B64_CHARS.charAt((n2 >> 12) & 63) +
                _B64_CHARS.charAt((n2 >> 6) & 63) + "=";
        }
        return out;
    }

    function _b64decode(s) {
        var out = "";
        var buffer = 0, bits = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === "=" || c === "\n" || c === "\r") continue;
            var idx = _B64_CHARS.indexOf(c);
            if (idx < 0) throw new Error("invalid base64 character: " + c);
            buffer = (buffer << 6) | idx;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((buffer >> bits) & 0xFF);
            }
        }
        return out;
    }

    function readFileChunk(optsJSON) {
        try {
            var opts = JSON.parse(optsJSON);
            var path = String(opts.path || "");
            var offset = Number(opts.offset || 0);
            var size = Number(opts.size || 0);
            var f = new File(path);
            if (!f.exists) return _err("readFileChunk: file not found: " + path);
            f.encoding = "binary";
            if (!f.open("r")) return _err("readFileChunk: cannot open " + path);
            try {
                if (offset > 0 && !f.seek(offset, 0)) {
                    return _err("readFileChunk: seek failed at " + offset);
                }
                var text = f.read(size);
                for (var i = 0; i < text.length; i++) {
                    if (text.charCodeAt(i) > 255) {
                        return _err(
                            "readFileChunk: binary read produced non-byte data at offset " +
                            offset + " (ExtendScript binary fidelity check failed on AE 26); " +
                            "install Node-fs or use the <=64 MB legacy path"
                        );
                    }
                }
                return JSON.stringify({
                    ok: true, base64: _b64encode(text), bytes: text.length
                });
            } finally {
                f.close();
            }
        } catch (e) {
            return _err("readFileChunk failed: " + _errorText(e));
        }
    }

    function writeFileChunk(optsJSON) {
        try {
            var opts = JSON.parse(optsJSON);
            var path = String(opts.path || "");
            var offset = Number(opts.offset || 0);
            var f = new File(path);
            f.encoding = "binary";
            // offset 0 (re)creates/truncates; later chunks append in place.
            var mode = (offset === 0 || !f.exists) ? "w" : "r+";
            if (!f.open(mode)) return _err("writeFileChunk: cannot open " + path + " (" + mode + ")");
            try {
                if (offset > 0 && !f.seek(offset, 0)) {
                    return _err("writeFileChunk: seek failed at " + offset);
                }
                var text = _b64decode(String(opts.data || ""));
                f.write(text);
                return JSON.stringify({ ok: true, bytes: text.length });
            } finally {
                f.close();
            }
        } catch (e) {
            return _err("writeFileChunk failed: " + _errorText(e));
        }
    }

    function fileSizeJSON(optsJSON) {
        try {
            var opts = JSON.parse(optsJSON);
            var path = String(opts.path || "");
            var f = new File(path);
            var size = f.exists ? f.length : -1;
            return JSON.stringify({ ok: size >= 0, size: size, path: path });
        } catch (e) {
            return _err("fileSize failed: " + _errorText(e));
        }
    }

    // comp.workAreaDuration exists since AE 2020 (16.x); guard for safety.
    function _workArea(comp) {
        var start = 0, dur = comp.duration;
        try {
            if (typeof comp.workAreaStart !== "undefined" &&
                typeof comp.workAreaDuration !== "undefined" &&
                comp.workAreaDuration > 0 &&
                comp.workAreaDuration < comp.duration) {
                start = comp.workAreaStart;
                dur = comp.workAreaDuration;
            }
        } catch (e) { /* property unavailable: use full comp */ }
        return { start: start, duration: dur };
    }

    function _colorState() {
        var s = {
            color_engine: "adobe_icc",
            project_working_space: "",
            project_bits_per_channel: 16,
            linearize_working_space: false,
            linear_blending: false
        };
        try { s.project_working_space = String(app.project.workingSpace || ""); } catch (e) {}
        try { s.project_bits_per_channel = app.project.bitsPerChannel; } catch (e) {}
        try { s.linearize_working_space = !!app.project.linearizeWorkingSpace; } catch (e) {}
        try { s.linear_blending = !!app.project.linearBlending; } catch (e) {}
        // OCIO-managed projects report OCIO configs; detect best effort.
        try {
            if (app.project.ocioConfigPath &&
                String(app.project.ocioConfigPath).length > 0) {
                s.color_engine = "ocio";
            }
        } catch (e) { /* older AE: ICC only */ }
        return s;
    }

    // --- context -----------------------------------------------------------

    function getContextJSON() {
        try {
            var comp = _activeComp();
            if (!comp) return _err("no active composition");
            var layer = _selectedLayer(comp);
            var wa = _workArea(comp);
            var color = _colorState();
            return JSON.stringify({
                ok: true,
                comp_id: comp.id,
                comp_name: comp.name,
                width: comp.width,
                height: comp.height,
                pixel_aspect: comp.pixelAspect,
                fps: comp.frameRate,
                duration_seconds: comp.duration,
                current_time: comp.time,
                work_area_start: wa.start,
                work_area_duration: wa.duration,
                has_work_area: (wa.duration < comp.duration),
                selected_layer_index: layer ? layer.index : 0,
                selected_layer_name: layer ? layer.name : "",
                selected_layer_in: layer ? layer.inPoint : 0,
                selected_layer_out: layer ? layer.outPoint : comp.duration,
                color: color
            });
        } catch (e) {
            return _err("getContext failed: " + _errorText(e));
        }
    }

    // --- manifest ----------------------------------------------------------

    function buildManifest(opts, ctx) {
        if (!_manifestLib) throw new Error("manifest.jsx not loaded");
        return _manifestLib.buildManifest(opts, ctx);
    }

    // --- render queue helpers ----------------------------------------------

    function _newRenderItem(comp) {
        var rq = app.project.renderQueue;
        var item = rq.items.add(comp);
        return item;
    }

    function _applyStillFormat(om, imageFormat) {
        var templates = om.templates;
        var wanted = (imageFormat === "jpg") ? "JPEG Sequence" : "PNG Sequence";
        for (var i = 0; i < templates.length; i++) {
            if (templates[i] === wanted) {
                om.applyTemplate(wanted);
                return wanted;
            }
        }
        throw new Error("output module template not available: " + wanted);
    }

    function _setSingleFrameSequencePath(om, folder, baseName) {
        // Sequence templates append [#####]; render one frame and locate the
        // produced file afterwards.
        om.file = new File(_join(folder, baseName));
    }

    function _findRenderedFile(folder, baseName, exts) {
        var files = new Folder(folder).getFiles();
        for (var i = 0; i < files.length; i++) {
            var name = String(files[i].name);
            if (name.indexOf(baseName) !== 0) continue;
            for (var e = 0; e < exts.length; e++) {
                if (name.toLowerCase().lastIndexOf(exts[e]) ===
                        name.length - exts[e].length) {
                    return files[i].fsName;
                }
            }
        }
        return null;
    }

    // Best-effort Output Module color settings. Setting keys are AE-version
    // dependent (validation point); failure is non-fatal and reported via the
    // color_applied flag so the panel can surface a warning.
    function _applyColorSettings(om, manifest) {
        try {
            var mode = manifest.bridge_color_mode;
            if (mode === "srgb" || mode === "rec709") {
                om.setSettings({ "Output Profile": manifest.output_color_space });
            } else {
                om.setSettings({ "Preserve RGB": true });
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function _waitForCompletedFile(path, timeoutMs) {
        var deadline = new Date().getTime() + timeoutMs;
        var lastSize = -1;
        var stableChecks = 0;
        while (new Date().getTime() < deadline) {
            var candidate = new File(path);
            if (candidate.exists && candidate.length > 0) {
                if (candidate.length === lastSize) stableChecks++;
                else stableChecks = 0;
                lastSize = candidate.length;
                if (stableChecks >= 2) return candidate.fsName;
            }
            $.sleep(50);
        }
        throw new Error("frame render did not finish: " + path);
    }

    function _renderStillToFile(comp, time, folder, baseName, imageFormat, manifest) {
        var savedTime = comp.time;
        var outPath = _join(folder, baseName + ".png");
        var outFile = new File(outPath);
        try {
            // PNG/JPEG output-module templates are user-installation dependent;
            // AE 26's default templates often contain neither. saveFrameToPng
            // is template-independent and preserves alpha for ComfyUI masks.
            if (outFile.exists && !outFile.remove()) {
                throw new Error("cannot replace still frame: " + outPath);
            }
            comp.time = time;
            comp.saveFrameToPng(time, outFile);
            return {
                path: _waitForCompletedFile(outPath, 30000),
                color_applied: false,
                transport_format: "png"
            };
        } finally {
            comp.time = savedTime;
        }
    }

    // Build a temp comp showing only the selected layer's alpha as white-on-
    // black luminance, optionally inverted. Used for mask exports.
    //
    // Implementation: comp.duplicate() preserves every relationship, then we
    // prune to the dependency closure (selected layer, its parent chain, its
    // track-matte chain, and layers that consume it as parent or matte). The
    // white solid is matted by the duplicated selected layer so the render is
    // pure grayscale mask data; a black solid sits at the bottom.
    //
    // Track-matte note: a matted layer used AS a matte source is assumed to
    // carry its own matte's alpha through (live-verify on AE 26; if wrong the
    // closure still keeps the matte chain and the white solid must matte off a
    // precomposited variant instead).
    function _buildMaskComp(comp, layer, invert, name) {
        var dup = null;
        try {
            var selectedIndex = layer.index;
            dup = comp.duplicate();
            try { dup.name = name; } catch (ignored) {}
            try { dup.displayStartTime = comp.displayStartTime; } catch (ignored) {}

            // Dependency closure over the ORIGINAL comp indices.
            var keep = {};
            var stack = [selectedIndex];
            keep[selectedIndex] = true;
            while (stack.length) {
                var idx = stack.pop();
                var src = comp.layer(idx);
                if (!src) continue;
                var parent = null;
                try { parent = src.parent; } catch (e) {}
                if (parent && !keep[parent.index]) {
                    keep[parent.index] = true;
                    stack.push(parent.index);
                }
                // Track matte of a layer is the layer directly above it.
                if (idx > 1) {
                    try {
                        var hasMatte = typeof src.trackMatteType !== "undefined" &&
                            src.trackMatteType !== TrackMatteType.NO_TRACK_MATTE;
                        if (hasMatte && !keep[idx - 1]) {
                            keep[idx - 1] = true;
                            stack.push(idx - 1);
                        }
                    } catch (e) {}
                }
                // Descendants: layers that use this layer as parent or matte.
                for (var j = 1; j <= comp.numLayers; j++) {
                    if (keep[j]) continue;
                    var cand = comp.layer(j);
                    var candParent = null;
                    try { candParent = cand.parent; } catch (e) {}
                    if (candParent && candParent.index === idx) {
                        keep[j] = true;
                        stack.push(j);
                        continue;
                    }
                    if (j > 1) {
                        try {
                            if (typeof cand.trackMatteType !== "undefined" &&
                                cand.trackMatteType !== TrackMatteType.NO_TRACK_MATTE &&
                                comp.layer(j - 1).index === idx) {
                                keep[j] = true;
                                stack.push(j);
                            }
                        } catch (e) {}
                    }
                }
            }

            // Snapshot live layer references from the duplicate, then remove
            // everything outside the closure (removing by reference avoids
            // index shifting).
            var allRefs = [];
            for (var k = 1; k <= comp.numLayers; k++) allRefs.push(dup.layer(k));
            for (var k2 = comp.numLayers; k2 >= 1; k2--) {
                if (!keep[k2]) {
                    try { allRefs[k2 - 1].remove(); } catch (e) {}
                }
            }
            var selDup = allRefs[selectedIndex - 1];
            if (!selDup) throw new Error("mask comp: duplicated selected layer not found");

            // Solid black background.
            var bg = dup.layers.addSolid(
                [0, 0, 0], "ae2c_bg", dup.width, dup.height,
                dup.pixelAspect, dup.duration
            );
            // White solid matted by the duplicated selected layer's alpha.
            var white = dup.layers.addSolid(
                [1, 1, 1], "ae2c_white", dup.width, dup.height,
                dup.pixelAspect, dup.duration
            );
            bg.moveToEnd();
            var matteType = invert ? TrackMatteType.ALPHA_INVERTED
                                   : TrackMatteType.ALPHA;
            if (typeof white.setTrackMatte === "function") {
                white.setTrackMatte(selDup, matteType);
            } else {
                selDup.moveBefore(white);
                white.trackMatteType = matteType;
            }
            return dup;
        } catch (e) {
            if (dup) {
                try { dup.remove(); } catch (e2) {}
            }
            throw e;
        }
    }

    // --- public: still export ------------------------------------------------

    function exportStill(optsJSON) {
        var item = null, maskComp = null;
        try {
            var opts = JSON.parse(optsJSON);
            var comp = _activeComp();
            if (!comp) return _err("no active composition");
            var layer = _selectedLayer(comp);
            if (!layer) return _err("no layer selected");

            var ctx = JSON.parse(getContextJSON());
            if (!ctx.ok) return _err(ctx.error);
            var manifest = buildManifest(opts, ctx);

            var jobDir = _join(opts.staging_folder, manifest.job_id);
            _ensureFolder(jobDir);

            var main = _renderStillToFile(
                comp, ctx.current_time, jobDir, "main", "png", manifest
            );
            var mainPath = main.path;
            var colorApplied = main.color_applied;

            var maskPath = "";
            if (manifest.mask_mode !== "none") {
                maskComp = _buildMaskComp(
                    comp, layer, _manifestLib.maskModeInvertsAlpha(manifest.mask_mode),
                    "AE2C Mask " + manifest.job_id
                );
                // Masks are data: always preserve RGB.
                var maskManifest = JSON.parse(JSON.stringify(manifest));
                maskManifest.bridge_color_mode = "preserve_rgb";
                maskPath = _renderStillToFile(
                    maskComp, ctx.current_time, jobDir, "mask", "png", maskManifest
                ).path;
            }

            var manifestPath = _join(jobDir, "job_manifest.json");
            _writeFile(manifestPath, JSON.stringify(manifest, null, 2));

            return JSON.stringify({
                ok: true,
                main_path: mainPath,
                mask_path: maskPath,
                manifest_path: manifestPath,
                manifest: manifest,
                color_applied: colorApplied
            });
        } catch (e) {
            return _err("exportStill failed: " + _errorText(e));
        } finally {
            if (maskComp) {
                try { maskComp.remove(); } catch (e) {}
            }
        }
    }

    // --- public: manifest read (used by tests + import validation) -----------

    function manifestFieldsJSON() {
        var fields = _manifestLib ? _manifestLib.MANIFEST_FIELDS : [];
        return JSON.stringify({ ok: !!_manifestLib, fields: fields });
    }

    // --- video export (AME) --------------------------------------------------

    // AME transfer sends ALL queued render items, so we park the user's items
    // (render=false), queue ours, then restore. AE-version verification point:
    // whether transferred items stay in the AE queue afterwards.
    var _videoJobs = {};

    var AE2C_TEMPLATE_NAMES = {
        prores_4444: "AE2C ProRes 4444",
        prores_422hq: "AE2C ProRes 422 HQ",
        mp4: "AE2C H.264 15 Mbps"
    };

    var TEMPLATE_CANDIDATES = {
        prores_4444: [
            AE2C_TEMPLATE_NAMES.prores_4444,
            "Apple ProRes 4444", "ProRes 4444", "High Quality with Alpha"
        ],
        prores_422hq: [
            AE2C_TEMPLATE_NAMES.prores_422hq,
            "Apple ProRes 422 HQ", "ProRes 422 HQ"
        ],
        mp4: [
            AE2C_TEMPLATE_NAMES.mp4,
            "H.264 - Match Render Settings - 15 Mbps",
            "H.264 - Match Render Settings - 40 Mbps",
            "H.264 - Match Render Settings -  5 Mbps"
        ]
    };

    function _templateExists(templates, name) {
        for (var i = 0; i < templates.length; i++) {
            if (templates[i] === name) return true;
        }
        return false;
    }

    function _findTemplate(templates, names) {
        for (var n = 0; n < names.length; n++) {
            if (_templateExists(templates, names[n])) return names[n];
        }
        return "";
    }

    function _ensureTemplateAlias(om, alias, sourceCandidates) {
        var available = om.templates;
        if (_templateExists(available, alias)) {
            return { name: alias, state: "ready", source: alias };
        }
        var source = _findTemplate(available, sourceCandidates);
        if (!source) {
            return {
                name: alias,
                state: "missing",
                sources_checked: sourceCandidates
            };
        }
        om.applyTemplate(source);
        om.saveAsTemplate(alias);
        return { name: alias, state: "created", source: source };
    }

    function setupTemplatesJSON() {
        var item = null;
        try {
            var comp = _activeComp();
            if (!comp) return _err("open or select a composition before setting up templates");
            item = _newRenderItem(comp);
            var om = item.outputModule(1);
            var results = [
                _ensureTemplateAlias(om, AE2C_TEMPLATE_NAMES.prores_4444, [
                    "Apple ProRes 4444", "ProRes 4444", "High Quality with Alpha"
                ]),
                _ensureTemplateAlias(om, AE2C_TEMPLATE_NAMES.prores_422hq, [
                    "Apple ProRes 422 HQ", "ProRes 422 HQ"
                ]),
                _ensureTemplateAlias(om, AE2C_TEMPLATE_NAMES.mp4, [
                    "H.264 - Match Render Settings - 15 Mbps",
                    "H.264 - Match Render Settings - 40 Mbps",
                    "H.264 - Match Render Settings -  5 Mbps"
                ])
            ];
            var ready = [], created = [], missing = [];
            for (var i = 0; i < results.length; i++) {
                if (results[i].state === "created") created.push(results[i]);
                else if (results[i].state === "ready") ready.push(results[i]);
                else missing.push(results[i]);
            }
            return JSON.stringify({
                ok: true,
                ready: ready,
                created: created,
                missing: missing,
                still_transport: "PNG (no Output Module template required)"
            });
        } catch (e) {
            return _err("template setup failed: " + _errorText(e));
        } finally {
            if (item) {
                try { item.remove(); } catch (ignored) {}
            }
        }
    }

    function _applyTemplateByName(om, overrideName, candidates) {
        var wanted = [];
        if (overrideName) wanted.push(overrideName);
        for (var c = 0; c < candidates.length; c++) {
            if (!_templateExists(wanted, candidates[c])) wanted.push(candidates[c]);
        }
        var available = om.templates;
        for (var w = 0; w < wanted.length; w++) {
            for (var i = 0; i < available.length; i++) {
                if (available[i] === wanted[w]) {
                    om.applyTemplate(wanted[w]);
                    return wanted[w];
                }
            }
        }
        throw new Error(
            "output module template not found: " + wanted.join(" | ") +
            " — configure AME template names in Settings. Available: " +
            available.join(", ")
        );
    }

    function _queueVideoRender(comp, start, duration, outPath, templateOverride, candidates, manifest) {
        var rq = app.project.renderQueue;
        var parked = [];
        var item = null;
        var colorApplied = false;
        try {
            for (var i = 1; i <= rq.numItems; i++) {
                try {
                    var it = rq.item(i);
                    if (it.render) {
                        it.render = false;
                        parked.push(it);
                    }
                } catch (e) {}
            }
            item = rq.items.add(comp);
            item.timeSpanStart = start;
            item.timeSpanDuration = duration;
            var om = item.outputModule(1);
            _applyTemplateByName(om, templateOverride, candidates);
            if (manifest) colorApplied = _applyColorSettings(om, manifest);
            om.file = new File(outPath);
            rq.queueInAME(true);
        } finally {
            for (var p = 0; p < parked.length; p++) {
                try { parked[p].render = true; } catch (e) {}
            }
            // If our item survived the AME transfer in the AE queue, disable
            // it so a later manual render doesn't redo it.
            if (item) {
                try { item.render = false; } catch (e) {}
            }
        }
        return colorApplied;
    }

    function exportVideo(optsJSON) {
        var maskComp = null;
        var jobRegistered = false;
        try {
            var opts = JSON.parse(optsJSON);
            var comp = _activeComp();
            if (!comp) return _err("no active composition");
            var layer = _selectedLayer(comp);
            if (!layer) return _err("no layer selected");

            var ctx = JSON.parse(getContextJSON());
            if (!ctx.ok) return _err(ctx.error);
            var manifest = buildManifest(opts, ctx);

            var jobDir = _join(opts.staging_folder, manifest.job_id);
            _ensureFolder(jobDir);

            var fmt = manifest.video_format; // mov | mp4
            var mainPath = _join(jobDir, "main." + fmt);
            var maskPath = manifest.mask_mode !== "none"
                ? _join(jobDir, "mask.mp4") : "";

            var start = manifest.timeline_start_seconds;
            var dur = manifest.duration_seconds;

            var colorApplied = false;
            // Main transport is the complete composition rendered over the
            // selected layer's in/out range (frame-quantized in the manifest).
            // Comp resolution/settings are untouched.
            var candidates = (fmt === "mp4")
                ? TEMPLATE_CANDIDATES.mp4
                : TEMPLATE_CANDIDATES[manifest.mov_codec];
            colorApplied = _queueVideoRender(comp, start, dur, mainPath,
                opts.ame_main_template || "", candidates, manifest);

            if (maskPath) {
                maskComp = _buildMaskComp(
                    comp, layer, _manifestLib.maskModeInvertsAlpha(manifest.mask_mode),
                    "AE2C Mask " + manifest.job_id
                );
                // Render the same comp-space interval as the main video. The
                // mask comp retains the source comp duration and layer timing.
                var maskManifest = JSON.parse(JSON.stringify(manifest));
                maskManifest.bridge_color_mode = "preserve_rgb";
                _queueVideoRender(maskComp, start, dur, maskPath,
                    opts.ame_mask_template || "", TEMPLATE_CANDIDATES.mp4,
                    maskManifest);
            }

            var manifestPath = _join(jobDir, "job_manifest.json");
            _writeFile(manifestPath, JSON.stringify(manifest, null, 2));

            _videoJobs[manifest.job_id] = {
                main_path: mainPath,
                mask_path: maskPath,
                mask_comp: maskComp,
                sizes: {},
                stable: {},
                started: new Date().getTime()
            };
            jobRegistered = true;
            // The mask comp must survive until AME finishes; it is removed in
            // exportVideoStatus (done) or cancelVideo, never here.
            maskComp = null;

            return JSON.stringify({
                ok: true,
                queued: true,
                main_path: mainPath,
                mask_path: maskPath,
                manifest_path: manifestPath,
                manifest: manifest,
                color_applied: colorApplied
            });
        } catch (e) {
            return _err("exportVideo failed: " + _errorText(e));
        } finally {
            // Only clean up a mask comp that was built but never handed to a
            // registered job (export failed before _videoJobs was set).
            if (!jobRegistered && maskComp) {
                try { maskComp.remove(); } catch (e) {}
            }
        }
    }

    function _cleanupVideoJob(job, jobId) {
        if (job && job.mask_comp) {
            try { job.mask_comp.remove(); } catch (e) {}
            job.mask_comp = null;
        }
        delete _videoJobs[jobId];
    }

    function _fileStable(job, path) {
        var f = new File(path);
        if (!f.exists || f.length <= 0) return false;
        var size = f.length;
        if (job.sizes[path] === size) {
            job.stable[path] = (job.stable[path] || 0) + 1;
        } else {
            job.stable[path] = 0;
        }
        job.sizes[path] = size;
        return job.stable[path] >= 1; // unchanged across two polls
    }

    function exportVideoStatus(optsJSON) {
        try {
            var opts = JSON.parse(optsJSON);
            var job = _videoJobs[opts.job_id];
            if (!job) return _err("unknown video job: " + opts.job_id);
            var mainDone = _fileStable(job, job.main_path);
            var maskDone = !job.mask_path || _fileStable(job, job.mask_path);
            var elapsed = new Date().getTime() - job.started;
            if (mainDone && maskDone) {
                // AME is done with the mask comp; release it now.
                _cleanupVideoJob(job, opts.job_id);
                return JSON.stringify({
                    ok: true,
                    done: true,
                    main_ready: true,
                    mask_ready: true,
                    elapsed_ms: elapsed
                });
            }
            return JSON.stringify({
                ok: true,
                done: false,
                main_ready: mainDone,
                mask_ready: maskDone,
                elapsed_ms: elapsed
            });
        } catch (e) {
            return _err("exportVideoStatus failed: " + _errorText(e));
        }
    }

    function cancelVideo(optsJSON) {
        // Stops local tracking/polling and releases the mask comp. The AME
        // encode and the ComfyUI queue item keep running server-side; the
        // panel also POSTs /interrupt.
        try {
            var opts = JSON.parse(optsJSON);
            var job = _videoJobs[opts.job_id];
            var existed = !!job;
            _cleanupVideoJob(job, opts.job_id);
            return JSON.stringify({ ok: true, cancelled: existed });
        } catch (e) {
            return _err("cancelVideo failed: " + _errorText(e));
        }
    }

    // --- result import -------------------------------------------------------

    function _findCompById(compId) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.id === compId) return item;
        }
        return null;
    }

    function _importFile(path) {
        var io = new ImportOptions(new File(path));
        return app.project.importFile(io);
    }

    function importResult(optsJSON) {
        try {
            var opts = JSON.parse(optsJSON);
            var manifest = opts.manifest;
            if (!manifest || !manifest.job_id) return _err("importResult: no manifest");
            var resultPath = String(opts.result_path || "");
            if (!new File(resultPath).exists) {
                return _err("result file not found: " + resultPath);
            }

            var comp = _findCompById(manifest.comp_id);
            if (!comp) return _err("composition no longer exists (id " + manifest.comp_id + ")");

            // Capture the placement target before adding the result. Adding a
            // layer inserts it at index 1 and shifts all existing indices.
            var placementTarget = null;
            if (manifest.placement !== "top_of_comp") {
                var targetIndex = manifest.selected_layer_index;
                if (targetIndex > 0 && targetIndex <= comp.numLayers) {
                    placementTarget = comp.layer(targetIndex);
                }
            }

            var footage = _importFile(resultPath);

            // Hard validation: no silent geometry/time drift.
            var problems = [];
            if (footage.width !== manifest.width || footage.height !== manifest.height) {
                problems.push("dimensions " + footage.width + "x" + footage.height +
                    " != manifest " + manifest.width + "x" + manifest.height);
            }
            if (manifest.media_type === "video") {
                try {
                    var fpsDelta = Math.abs((footage.frameRate || manifest.fps) - manifest.fps);
                    if (fpsDelta > 0.05) {
                        problems.push("fps " + footage.frameRate + " != " + manifest.fps);
                    }
                    var resultFrames = footage.duration * manifest.fps;
                    if (Math.abs(resultFrames - manifest.frame_count) > 1.5) {
                        problems.push("frame count ~" + Math.round(resultFrames) +
                            " != " + manifest.frame_count);
                    }
                } catch (e) {
                    problems.push("cannot verify fps/duration: " + _errorText(e));
                }
            }
            if (problems.length) {
                try { footage.remove(); } catch (e) {}
                return _err("result mismatch: " + problems.join("; "));
            }

            var layer = comp.layers.add(footage);
            layer.name = "AE2C Result " + manifest.job_id.substring(0, 8);

            var anchor = manifest.timeline_start_seconds;
            if (manifest.media_type === "video") {
                layer.startTime = 0;
                layer.inPoint = anchor;
                layer.outPoint = anchor + footage.duration;
            } else {
                // Still: span the comp so it is visible at the anchor time;
                // the user trims as needed.
                layer.startTime = 0;
                layer.inPoint = 0;
                layer.outPoint = comp.duration;
            }

            if (manifest.placement === "top_of_comp") {
                layer.moveToBeginning();
            } else if (placementTarget && placementTarget !== layer) {
                layer.moveBefore(placementTarget);
            } else {
                layer.moveToBeginning();
            }

            return JSON.stringify({
                ok: true,
                layer_index: layer.index,
                layer_name: layer.name,
                placed_at_seconds: anchor
            });
        } catch (e) {
            return _err("importResult failed: " + _errorText(e));
        }
    }

    return {
        getContextJSON: getContextJSON,
        exportStill: exportStill,
        exportVideo: exportVideo,
        exportVideoStatus: exportVideoStatus,
        cancelVideo: cancelVideo,
        importResult: importResult,
        buildManifest: buildManifest,
        manifestFieldsJSON: manifestFieldsJSON,
        setupTemplatesJSON: setupTemplatesJSON,
        readFileChunk: readFileChunk,
        writeFileChunk: writeFileChunk,
        fileSizeJSON: fileSizeJSON
    };
})();
