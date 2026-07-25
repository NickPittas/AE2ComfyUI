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
            return _err("getContext failed: " + e);
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

    function _renderStillToFile(comp, time, folder, baseName, imageFormat) {
        var rq = app.project.renderQueue;
        var item = null;
        var savedTime = comp.time;
        try {
            comp.time = time;
            item = _newRenderItem(comp);
            item.timeSpanStart = time;
            item.timeSpanDuration = 1 / comp.frameRate;
            var om = item.outputModule(1);
            _applyStillFormat(om, imageFormat);
            _setSingleFrameSequencePath(om, folder, baseName + "_[#####]");
            rq.render();
            var found = _findRenderedFile(
                folder, baseName + "_",
                (imageFormat === "jpg") ? [".jpg", ".jpeg"] : [".png"]
            );
            if (!found) throw new Error("render produced no file for " + baseName);
            return found;
        } finally {
            comp.time = savedTime;
            if (item) {
                try { item.remove(); } catch (e) {}
            }
        }
    }

    // Build a temp comp showing only the selected layer's alpha as white-on-
    // black luminance, optionally inverted. Used for mask exports.
    function _buildMaskComp(comp, layer, invert, name) {
        var maskComp = app.project.items.addComp(
            name, comp.width, comp.height, comp.pixelAspect,
            comp.duration, comp.frameRate
        );
        try {
            // Solid black background.
            var bg = maskComp.layers.addSolid(
                [0, 0, 0], "ae2c_bg", comp.width, comp.height,
                comp.pixelAspect, comp.duration
            );
            // Copy of the source layer; use its alpha as a track matte over a
            // white solid so the render is pure grayscale mask data.
            var white = maskComp.layers.addSolid(
                [1, 1, 1], "ae2c_white", comp.width, comp.height,
                comp.pixelAspect, comp.duration
            );
            layer.copyToComp(maskComp);
            var matte = maskComp.layer(maskComp.numLayers);
            white.moveBefore(matte);
            try {
                white.trackMatteType = invert ? TrackMatteType.ALPHA_INVERTED
                                              : TrackMatteType.ALPHA;
            } catch (e) {
                throw new Error("track matte setup failed: " + e);
            }
            bg.moveToBeginning();
            return maskComp;
        } catch (e) {
            try { maskComp.remove(); } catch (e2) {}
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

            var fmt = (opts.image_format === "jpg") ? "jpg" : "png";
            var mainPath = _renderStillToFile(
                comp, ctx.current_time, jobDir, "main", fmt
            );

            var maskPath = "";
            if (manifest.mask_mode !== "none") {
                maskComp = _buildMaskComp(
                    comp, layer, manifest.mask_mode === "invert",
                    "AE2C Mask " + manifest.job_id
                );
                maskPath = _renderStillToFile(
                    maskComp, ctx.current_time, jobDir, "mask", "png"
                );
            }

            var manifestPath = _join(jobDir, "job_manifest.json");
            _writeFile(manifestPath, JSON.stringify(manifest, null, 2));

            return JSON.stringify({
                ok: true,
                main_path: mainPath,
                mask_path: maskPath,
                manifest_path: manifestPath,
                manifest: manifest
            });
        } catch (e) {
            return _err("exportStill failed: " + e);
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

    return {
        getContextJSON: getContextJSON,
        exportStill: exportStill,
        buildManifest: buildManifest,
        manifestFieldsJSON: manifestFieldsJSON
    };
})();
