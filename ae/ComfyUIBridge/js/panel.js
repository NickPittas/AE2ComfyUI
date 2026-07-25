/* AE2ComfyUI panel: UI wiring + end-to-end generate flow.
 *
 * Flow: context → export (still/video) → upload assets → patch workflow →
 * queue → wait → download result → import into comp at the manifest anchor.
 *
 * Host access goes through evalScriptAsync, which works with Adobe's
 * CSInterface.js when present and falls back to window.__adobe_cep__.
 */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }

    // --- host bridge -------------------------------------------------------

    function evalScriptAsync(script) {
        return new Promise(function (resolve, reject) {
            function done(raw) {
                var data;
                try { data = JSON.parse(raw); }
                catch (e) { return reject(new Error("bad host response: " + String(raw).slice(0, 200))); }
                if (data && data.ok) return resolve(data);
                reject(new Error((data && data.error) || "host call failed"));
            }
            try {
                if (typeof CSInterface !== "undefined") {
                    new CSInterface().evalScript(script, done);
                } else if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
                    window.__adobe_cep__.evalScript(script, done);
                } else {
                    reject(new Error("CEP host bridge unavailable"));
                }
            } catch (e) {
                reject(e);
            }
        });
    }

    function hostCall(expr) {
        return evalScriptAsync("AE2C." + expr);
    }

    // --- local file helpers (Node in CEP, cep.fs fallback) ------------------

    function nodeFs() {
        try { return require("fs"); } catch (e) { return null; }
    }

    function readFileBytes(path) {
        var fs = nodeFs();
        if (fs) return new Uint8Array(fs.readFileSync(path));
        var result = window.cep.fs.readFile(path, window.cep.encoding.Base64);
        if (result.err !== 0) throw new Error("cannot read " + path);
        var bin = atob(result.data);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function writeFileBytes(path, bytes) {
        var fs = nodeFs();
        if (fs) return fs.writeFileSync(path, Buffer.from(bytes));
        var bin = "";
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        var result = window.cep.fs.writeFile(path, btoa(bin), window.cep.encoding.Base64);
        if (result.err !== 0) throw new Error("cannot write " + path);
    }

    function ensureDir(path) {
        var fs = nodeFs();
        if (fs) return fs.mkdirSync(path, { recursive: true });
        window.cep.fs.makedir(path);
    }

    function fileExists(path) {
        var fs = nodeFs();
        if (fs) return fs.existsSync(path);
        return window.cep.fs.stat(path).err === 0;
    }

    function pathJoin(a, b) {
        var sep = a.indexOf("\\") !== -1 && a.indexOf("/") === -1 ? "\\" : "/";
        return a.replace(/[\\/]+$/, "") + sep + b;
    }

    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function browseFolder(input) {
        try {
            var res = window.cep.util.showOpenDialogEx(false, true, "Choose folder", "", []);
            if (res.err === 0 && res.data && res.data.length) input.value = res.data[0];
        } catch (e) { /* dialog unavailable (tests) */ }
    }

    // --- status helpers -----------------------------------------------------

    function setStatus(el, msg, cls) {
        el.textContent = msg;
        el.className = cls || "";
    }

    var runState = { running: false, jobId: null, client: null, cancelRequested: false };

    function setRunning(running) {
        runState.running = running;
        runState.cancelRequested = false;
        $("btn-queue").classList.toggle("hidden", running);
        $("btn-cancel").classList.toggle("hidden", !running);
        $("progress").classList.toggle("hidden", !running);
    }

    function checkCancelled() {
        if (runState.cancelRequested) throw new Error("cancelled");
    }

    // --- Tabs --------------------------------------------------------------
    function showTab(name) {
        var gen = name === "generate";
        $("page-generate").classList.toggle("hidden", !gen);
        $("page-settings").classList.toggle("hidden", gen);
        $("tab-generate").classList.toggle("active", gen);
        $("tab-settings").classList.toggle("active", !gen);
    }

    // --- Settings -----------------------------------------------------------
    var SETTING_FIELDS = {
        "set-host": "host", "set-port": "port", "set-staging": "stagingFolder",
        "set-result": "resultFolder", "set-workflowdirs": "workflowDirs",
        "set-ame-main": "ameMainTemplate", "set-ame-mask": "ameMaskTemplate"
    };

    function loadSettings() {
        Object.keys(SETTING_FIELDS).forEach(function (id) {
            $(id).value = Settings.get(SETTING_FIELDS[id]);
        });
        $("image-format").value = Settings.get("imageFormat");
        $("video-format").value = Settings.get("videoFormat") === "mp4" ? "mp4"
            : (Settings.get("movCodec") === "prores_422hq" ? "mov422" : "mov");
        $("color-mode").value = Settings.get("colorMode");
        $("placement").value = Settings.get("placement");
        $("result-folder").value = Settings.get("resultFolder");
    }

    function persistGenerateChoices() {
        Settings.set("imageFormat", $("image-format").value);
        var vf = $("video-format").value;
        Settings.set("videoFormat", vf === "mp4" ? "mp4" : "mov");
        Settings.set("movCodec", vf === "mov422" ? "prores_422hq" : "prores_4444");
        Settings.set("colorMode", $("color-mode").value);
        Settings.set("placement", $("placement").value);
        Settings.set("resultFolder", $("result-folder").value);
    }

    function saveSettings() {
        Object.keys(SETTING_FIELDS).forEach(function (id) {
            Settings.set(SETTING_FIELDS[id], $(id).value);
        });
        persistGenerateChoices();
        setStatus($("status-settings"), "Settings saved.", "ok");
        checkConnection();
    }

    // --- Connection + workflows --------------------------------------------
    function checkConnection() {
        var dot = $("conn-dot"), text = $("conn-text");
        dot.className = "dot";
        text.textContent = "checking…";
        var client = new ComfyClient(Settings.baseUrl());
        return client.health()
            .then(function () {
                dot.className = "dot on";
                text.textContent = Settings.get("host") + ":" + Settings.get("port");
                return true;
            })
            .catch(function () {
                dot.className = "dot";
                text.textContent = "disconnected";
                return false;
            });
    }

    function refreshWorkflows() {
        var sel = $("workflow");
        var client = new ComfyClient(Settings.baseUrl());
        return client.getWorkflows()
            .then(function (list) {
                var keep = sel.value;
                sel.innerHTML = "";
                list = list.filter(function (wf) {
                    return wf.has_from_ae && wf.has_to_ae;
                });
                if (!list.length) {
                    var opt = document.createElement("option");
                    opt.value = "";
                    opt.textContent = "(no workflows with AE nodes found)";
                    sel.appendChild(opt);
                    return;
                }
                list.forEach(function (wf) {
                    var opt = document.createElement("option");
                    opt.value = wf.id;
                    opt.textContent = (wf.source === "saved" ? "[saved] " : "[open] ") +
                        wf.name + " (" + wf.media + ")";
                    opt.dataset.media = wf.media;
                    sel.appendChild(opt);
                });
                if (keep) sel.value = keep;
            })
            .catch(function () {
                sel.innerHTML = "";
                var opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "(ComfyUI unreachable)";
                sel.appendChild(opt);
            });
    }

    function syncMediaRows() {
        var isVideo = $("media-type").value === "video";
        $("row-image-format").classList.toggle("hidden", isVideo);
        $("row-video-format").classList.toggle("hidden", !isVideo);
    }

    // --- Generate flow ------------------------------------------------------

    function gatherChoices() {
        var vf = $("video-format").value;
        return {
            job_id: uuid(),
            media_type: $("media-type").value,
            mask_mode: $("mask-mode").value,
            image_format: $("image-format").value,
            video_format: vf === "mp4" ? "mp4" : "mov",
            mov_codec: vf === "mov422" ? "prores_422hq" : "prores_4444",
            bridge_color_mode: $("color-mode").value,
            placement: $("placement").value,
            prompt: $("prompt").value,
            staging_folder: Settings.get("stagingFolder"),
            ame_main_template: Settings.get("ameMainTemplate"),
            ame_mask_template: Settings.get("ameMaskTemplate")
        };
    }

    function validateChoices(c) {
        if (!c.staging_folder) throw new Error("set a staging folder in Settings");
        if (!c.resultFolder) throw new Error("set a result folder (Generate tab or Settings)");
        var wfId = $("workflow").value;
        if (!wfId) throw new Error("no workflow selected");
        return wfId;
    }

    function waitForAmeExport(choices) {
        var statusEl = $("status");
        return new Promise(function (resolve, reject) {
            function tick() {
                if (runState.cancelRequested) {
                    hostCall("cancelVideo(" + JSON.stringify(JSON.stringify({ job_id: choices.job_id })) + ")")
                        .finally(function () { reject(new Error("cancelled")); });
                    return;
                }
                hostCall("exportVideoStatus(" + JSON.stringify(JSON.stringify({ job_id: choices.job_id })) + ")")
                    .then(function (s) {
                        if (s.done) return resolve();
                        setStatus(statusEl,
                            "Rendering in Adobe Media Encoder… " +
                            Math.round(s.elapsed_ms / 1000) + "s");
                        setTimeout(tick, 1500);
                    })
                    .catch(reject);
            }
            tick();
        });
    }

    function pollWorkflowCompat(workflowId, mediaType) {
        var opt = $("workflow").querySelector("option[value='" + workflowId + "']");
        var media = opt && opt.dataset ? opt.dataset.media : "";
        if (media && media !== "both" && media !== mediaType) {
            throw new Error("selected workflow is " + media + "-only; input is " + mediaType);
        }
    }

    function runGenerate() {
        var statusEl = $("status");
        var choices, workflowId, manifest, exportResult, client;
        try {
            choices = gatherChoices();
            choices.resultFolder = $("result-folder").value || Settings.get("resultFolder");
            workflowId = validateChoices(choices);
            pollWorkflowCompat(workflowId, choices.media_type);
        } catch (e) {
            setStatus(statusEl, e.message, "err");
            return;
        }
        persistGenerateChoices();
        setRunning(true);
        client = new ComfyClient(Settings.baseUrl());
        runState.client = client;
        runState.jobId = choices.job_id;

        var exportCall = choices.media_type === "video" ? "exportVideo" : "exportStill";
        setStatus(statusEl, "Reading comp context…");

        hostCall("getContextJSON()")
            .then(function (ctx) {
                setStatus(statusEl, choices.media_type === "video"
                    ? "Queueing AME render…" : "Rendering frame…");
                return hostCall(exportCall + "(" +
                    JSON.stringify(JSON.stringify(choices)) + ")");
            })
            .then(function (exp) {
                exportResult = exp;
                manifest = exp.manifest;
                checkCancelled();
                if (exp.color_applied === false) {
                    setStatus(statusEl, "Warning: output-module color settings " +
                        "were not applied (unsupported AE version) — verify " +
                        "colors manually.");
                }
                if (choices.media_type === "video") return waitForAmeExport(choices);
            })
            .then(function () {
                checkCancelled();
                setStatus(statusEl, "Uploading assets…");
                var mainBytes = readFileBytes(exportResult.main_path);
                return client.uploadAsset(choices.job_id, "main", mainBytes,
                    exportResult.main_path.split(/[\\/]/).pop(), manifest)
                    .then(function () {
                        if (exportResult.mask_path) {
                            var maskBytes = readFileBytes(exportResult.mask_path);
                            return client.uploadAsset(choices.job_id, "mask", maskBytes,
                                exportResult.mask_path.split(/[\\/]/).pop(), manifest);
                        }
                    });
            })
            .then(function () {
                checkCancelled();
                setStatus(statusEl, "Patching workflow…");
                return client.getWorkflowPrompt(workflowId);
            })
            .then(function (wf) {
                var check = AE2CPatch.validateWorkflow(wf.prompt, choices.media_type);
                if (check.errors.length) throw new Error(check.errors.join("; "));
                var patched = AE2CPatch.patchWorkflow(wf.prompt, {
                    job_id: choices.job_id,
                    asset_id: "main",
                    prompt_text: choices.prompt,
                    manifest: manifest
                });
                setStatus(statusEl, "Queueing in ComfyUI…");
                return client.queuePrompt(patched.prompt, wf.client_id);
            })
            .then(function (q) {
                setStatus(statusEl, "ComfyUI running…");
                return client.waitForCompletion(q.prompt_id, function (p) {
                    if (p.pending) setStatus(statusEl, "In ComfyUI queue…");
                });
            })
            .then(function () {
                checkCancelled();
                setStatus(statusEl, "Downloading result…");
                return client.downloadResult(choices.job_id);
            })
            .then(function (dl) {
                checkCancelled();
                var ext = dl.meta.format ||
                    (choices.media_type === "video" ? choices.video_format : choices.image_format);
                var outDir = pathJoin(choices.resultFolder, choices.job_id);
                ensureDir(outDir);
                var outPath = pathJoin(outDir, "result." + ext);
                writeFileBytes(outPath, dl.bytes);
                setStatus(statusEl, "Importing into comp…");
                return hostCall("importResult(" + JSON.stringify(JSON.stringify({
                    manifest: manifest,
                    result_path: outPath
                })) + ")").then(function (imp) {
                    return { outPath: outPath, imp: imp };
                });
            })
            .then(function (r) {
                setStatus(statusEl,
                    "Done: " + r.outPath + "\nPlaced layer \"" + r.imp.layer_name +
                    "\" at " + Number(r.imp.placed_at_seconds).toFixed(3) + "s.", "ok");
            })
            .catch(function (e) {
                var msg = (e && e.message) || String(e);
                setStatus(statusEl, msg === "cancelled" ? "Cancelled." : "Error: " + msg,
                    msg === "cancelled" ? "" : "err");
            })
            .finally(function () {
                setRunning(false);
                runState.jobId = null;
                runState.client = null;
            });
    }

    function cancelRun() {
        runState.cancelRequested = true;
        setStatus($("status"), "Cancelling…");
        if (runState.client) runState.client.interrupt().catch(function () {});
    }

    // --- init ---------------------------------------------------------------

    function init() {
        $("tab-generate").addEventListener("click", function () { showTab("generate"); });
        $("tab-settings").addEventListener("click", function () { showTab("settings"); });
        $("btn-save-settings").addEventListener("click", saveSettings);
        $("btn-test-conn").addEventListener("click", function () {
            checkConnection().then(function (ok) {
                setStatus($("status-settings"),
                    ok ? "Connected to " + Settings.baseUrl()
                       : "Cannot reach " + Settings.baseUrl() +
                         " — is ComfyUI running with the ae_bridge extension?",
                    ok ? "ok" : "err");
            });
        });
        $("btn-refresh").addEventListener("click", function () {
            checkConnection();
            refreshWorkflows();
        });
        $("media-type").addEventListener("change", syncMediaRows);
        $("btn-queue").addEventListener("click", function () {
            if (!runState.running) runGenerate();
        });
        $("btn-cancel").addEventListener("click", cancelRun);
        [
            ["btn-result-browse", "result-folder"],
            ["btn-staging-browse", "set-staging"],
            ["btn-result-browse2", "set-result"]
        ].forEach(function (pair) {
            $(pair[0]).addEventListener("click", function () { browseFolder($(pair[1])); });
        });

        loadSettings();
        syncMediaRows();
        checkConnection();
        refreshWorkflows();
    }

    document.addEventListener("DOMContentLoaded", init);
})();
