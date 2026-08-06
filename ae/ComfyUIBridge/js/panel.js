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

    var HOST_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

    function readTextFile(path) {
        var fs = nodeFs();
        if (fs) return fs.readFileSync(path, "utf8");
        var result = window.cep.fs.readFile(path);
        if (result.err !== 0) throw new Error("cannot read " + path + " (CEP error " + result.err + ")");
        return result.data;
    }

    function writeTextFile(path, text) {
        var fs = nodeFs();
        if (fs) return fs.writeFileSync(path, text, "utf8");
        var result = window.cep.fs.writeFile(path, text);
        if (result.err !== 0) throw new Error("cannot write " + path + " (CEP error " + result.err + ")");
    }

    function deleteFile(path) {
        var fs = nodeFs();
        if (fs) {
            if (fs.existsSync(path)) fs.unlinkSync(path);
            return;
        }
        if (window.cep && window.cep.fs && window.cep.fs.deleteFile) {
            window.cep.fs.deleteFile(path);
        }
    }

    function bridgeFolder() {
        var configured = "";
        try {
            configured = String(Settings.get("stagingFolder") || "").trim();
            if (!configured) configured = String(Settings.get("resultFolder") || "").trim();
        } catch (e) { /* Settings is unavailable only in isolated tests. */ }
        if (configured) return configured;
        var root = extensionRoot();
        return root ? pathJoin(root, ".ae2c-runtime") : "";
    }

    function panelLogPath() {
        var folder = bridgeFolder();
        return folder ? pathJoin(folder, "ae2comfyui-panel.log") : "";
    }

    function panelLog(event, detail) {
        var line = new Date().toISOString() + " [" + event + "]";
        if (detail !== undefined && detail !== null && detail !== "") line += " " + String(detail);
        try {
            if (typeof console !== "undefined" && console.log) console.log("AE2ComfyUI " + line);
        } catch (ignored) {}
        try {
            var path = panelLogPath();
            if (!path) return;
            ensureDir(bridgeFolder());
            var previous = fileExists(path) ? readTextFile(path) : "";
            if (previous.length > 250000) previous = previous.slice(-200000);
            writeTextFile(path, previous + line + "\n");
        } catch (ignoredWriteError) {
            try {
                if (typeof console !== "undefined" && console.error) {
                    console.error("AE2ComfyUI could not write panel log", ignoredWriteError);
                }
            } catch (ignoredConsoleError) {}
        }
    }

    function parseHostResponse(raw, label) {
        var data;
        try { data = JSON.parse(raw); }
        catch (e) {
            var prefix = label ? label + " returned" : "AE host returned";
            var value = String(raw || "<empty>").slice(0, 500);
            throw new Error(prefix + " an invalid response: " + value);
        }
        if (data && data.ok) return data;
        throw new Error((data && data.error) || "host call failed");
    }

    function submitEvalScript(script, label, callback) {
        panelLog("HOST SUBMIT", label || "unnamed call");
        if (typeof CSInterface !== "undefined") {
            new CSInterface().evalScript(script, callback);
        } else if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
            window.__adobe_cep__.evalScript(script, callback);
        } else {
            throw new Error("CEP host bridge unavailable");
        }
    }

    /*
     * AE 26 / CEP 12 can execute evalScript while delivering an empty callback.
     * Have ExtendScript write its result to a unique file and read that file from
     * CEP. The callback remains useful for diagnostics, but is not trusted as the
     * data channel.
     */
    function evalScriptAsync(script, label) {
        return new Promise(function (resolve, reject) {
            var folder = bridgeFolder();
            if (!folder) return reject(new Error("set a staging folder before calling the AE host"));
            ensureDir(folder);
            var responsePath = pathJoin(folder, ".ae2c-host-response-" + uuid() + ".json");
            var responseLiteral = JSON.stringify(responsePath);
            var wrapped = "(function(){" +
                "var __ae2cResult;" +
                "try{__ae2cResult=(" + script + ");}" +
                "catch(__ae2cError){__ae2cResult=JSON.stringify({ok:false,error:'ExtendScript error: '+__ae2cError.toString(),line:__ae2cError.line||0,file:__ae2cError.fileName||''});}" +
                "var __ae2cFile=new File(" + responseLiteral + ");" +
                "__ae2cFile.encoding='UTF-8';" +
                "if(__ae2cFile.open('w')){__ae2cFile.write(String(__ae2cResult));__ae2cFile.close();}" +
                "return __ae2cResult;" +
                "}())";
            var started = Date.now();
            var settled = false;

            function fail(error) {
                if (settled) return;
                settled = true;
                deleteFile(responsePath);
                panelLog("HOST ERROR", (label || "unnamed call") + ": " + error.message);
                reject(error);
            }

            function pollResponse() {
                if (settled) return;
                try {
                    if (fileExists(responsePath)) {
                        var raw = readTextFile(responsePath);
                        deleteFile(responsePath);
                        settled = true;
                        panelLog("HOST FILE RESPONSE", (label || "unnamed call") +
                            " bytes=" + raw.length + " value=" + String(raw).slice(0, 500));
                        try { resolve(parseHostResponse(raw, label)); }
                        catch (parseError) { reject(parseError); }
                        return;
                    }
                } catch (readError) {
                    return fail(readError);
                }
                if (Date.now() - started >= HOST_RESPONSE_TIMEOUT_MS) {
                    return fail(new Error((label || "AE host") +
                        " timed out without creating " + responsePath));
                }
                setTimeout(pollResponse, 50);
            }

            try {
                submitEvalScript(wrapped, label, function (raw) {
                    panelLog("HOST CALLBACK", (label || "unnamed call") +
                        " type=" + typeof raw + " bytes=" + String(raw || "").length +
                        " value=" + String(raw || "<empty>").slice(0, 500));
                    pollResponse();
                });
                setTimeout(pollResponse, 0);
            } catch (e) {
                fail(e);
            }
        });
    }

    var hostReadyPromise = null;

    function extensionRoot() {
        if (window.__adobe_cep__ &&
            typeof window.__adobe_cep__.getSystemPath === "function") {
            var root = window.__adobe_cep__.getSystemPath("extension");
            try { return decodeURI(root); } catch (e) { return root; }
        }
        return "";
    }

    function bootstrapHost() {
        var root = extensionRoot();
        if (!root) return Promise.reject(new Error("cannot resolve CEP extension root"));
        var hostPath = pathJoin(root, "jsx/host.jsx");
        var script = "(function(){try{$.evalFile(new File(" + JSON.stringify(hostPath) + "));" +
            "return typeof AE2C !== 'undefined' ? '{\"ok\":true,\"loaded\":true}' : " +
            "'{\"ok\":false,\"error\":\"AE2C unavailable\"}';" +
            "}catch(e){return JSON.stringify({ok:false,error:'host bootstrap failed: '+e.toString(),line:e.line||0});}}())";
        return evalScriptAsync(script, "AE host bootstrap").then(function (result) {
            if (!result.loaded) throw new Error("AE host script loaded but AE2C is unavailable");
            return result;
        });
    }

    function ensureHost() {
        if (!hostReadyPromise) {
            hostReadyPromise = bootstrapHost();
            hostReadyPromise.catch(function () { hostReadyPromise = null; });
        }
        return hostReadyPromise;
    }

    function hostCall(expr) {
        return ensureHost().then(function () {
            return evalScriptAsync("AE2C." + expr, "AE2C." + expr.split("(")[0]);
        });
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

    // --- chunked file IO (bounded-memory video transport) -------------------

    var CHUNK_BYTES = 4 * 1024 * 1024;          // Node-fs transport chunk size
    var HOST_CHUNK_BYTES = 256 * 1024;           // bounded CEP/ExtendScript handoff
    var LEGACY_MAX_WHOLE_FILE = 64 * 1024 * 1024; // cep.fs whole-file fallback cap
    var lastProgressLogAt = 0;

    function base64ToBytes(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function bytesToBase64(bytes) {
        var bin = "";
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function checksumBytes(bytes) {
        var sum = 0;
        for (var i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) % 4294967296;
        return sum;
    }

    function readChunkNode(path, offset, size) {
        var fs = nodeFs();
        var fd = fs.openSync(path, "r");
        try {
            var buf = Buffer.alloc(size);
            var n = fs.readSync(fd, buf, 0, size, offset);
            return new Uint8Array(buf.buffer, buf.byteOffset, n);
        } finally {
            fs.closeSync(fd);
        }
    }

    function readChunkHost(path, offset, size) {
        var tempPath = path + ".ae2c-read-" + offset + "-" + Date.now() + ".tmp";
        return hostCall("readFileChunkToFile(" + JSON.stringify(JSON.stringify({
            path: path, temp_path: tempPath, offset: offset, size: size
        })) + ")").then(function (r) {
            var result = window.cep.fs.readFile(tempPath, window.cep.encoding.Base64);
            if (result.err !== 0) throw new Error("cannot read temporary chunk " + tempPath);
            var bytes = base64ToBytes(result.data);
            if (bytes.length !== r.bytes) {
                throw new Error("temporary chunk size mismatch at " + offset +
                    ": host " + r.bytes + ", panel " + bytes.length);
            }
            if (checksumBytes(bytes) !== r.checksum) {
                throw new Error("temporary chunk checksum mismatch at " + offset);
            }
            return bytes;
        }).finally(function () {
            deleteFile(tempPath);
        });
    }

    function writeChunkNode(path, offset, bytes) {
        var fs = nodeFs();
        var fd = fs.openSync(path, offset === 0 ? "w" : "r+");
        try {
            fs.writeSync(fd, Buffer.from(bytes), 0, bytes.length, offset);
        } finally {
            fs.closeSync(fd);
        }
    }

    function writeChunkHost(path, offset, bytes) {
        var tempPath = path + ".ae2c-write-" + offset + "-" + Date.now() + ".tmp";
        var result = window.cep.fs.writeFile(
            tempPath, bytesToBase64(bytes), window.cep.encoding.Base64
        );
        if (result.err !== 0) return Promise.reject(new Error("cannot write temporary chunk " + tempPath));
        return hostCall("writeFileChunkFromFile(" + JSON.stringify(JSON.stringify({
            path: path, temp_path: tempPath, offset: offset
        })) + ")").finally(function () {
            deleteFile(tempPath);
        });
    }

    function fileSizeBytes(path) {
        var fs = nodeFs();
        if (fs) return Promise.resolve(fs.statSync(path).size);
        return hostCall("fileSizeJSON(" + JSON.stringify(JSON.stringify({ path: path })) + ")")
            .then(function (r) {
                if (!r.ok) throw new Error("cannot stat " + path);
                return r.size;
            });
    }

    function throttledProgressLog(event, jobId, done, total) {
        var now = Date.now();
        if (done === total || now - lastProgressLogAt > 1000) {
            lastProgressLogAt = now;
            panelLog(event, jobId + " " + done + "/" + total);
        }
    }

    function hostBridgeAvailable() {
        return typeof CSInterface !== "undefined" ||
            (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function");
    }

    // Stream one video asset to the server with bounded memory. Falls back to
    // the legacy whole-file path only for files <= 64 MB when no chunk reader
    // exists, with an explicit error above that cap.
    function uploadVideoAsset(client, jobId, path, assetId, manifest) {
        var fs = nodeFs();
        return fileSizeBytes(path).then(function (fileSize) {
            var reader;
            var chunkSize = CHUNK_BYTES;
            if (fs) {
                reader = function (offset, size) { return readChunkNode(path, offset, size); };
            } else if (hostBridgeAvailable()) {
                reader = function (offset, size) { return readChunkHost(path, offset, size); };
                chunkSize = HOST_CHUNK_BYTES;
            } else if (fileSize <= LEGACY_MAX_WHOLE_FILE) {
                panelLog("UPLOAD LEGACY", "no chunk reader; whole-file upload of " +
                    fileSize + " bytes for " + path);
                return client.uploadAsset(jobId, assetId, readFileBytes(path),
                    path.split(/[\\/]/).pop(), manifest);
            } else {
                throw new Error("cannot chunk-read " + path + " (" + fileSize +
                    " bytes > " + LEGACY_MAX_WHOLE_FILE +
                    " legacy limit); restart AE with the host bridge or Node fs");
            }
            panelLog("UPLOAD START", jobId + " " + assetId + " size=" + fileSize);
            return client.uploadAssetChunked(jobId, assetId, fileSize,
                path.split(/[\\/]/).pop(), manifest, reader,
                function (p) {
                    setProgress(p.uploaded, p.total);
                    throttledProgressLog("UPLOAD PROGRESS", jobId, p.uploaded, p.total);
                },
                chunkSize);
        });
    }

    // Upload main + mask, then verify registration server-side (GET jobs).
    function uploadAssets(client, choices, exportResult, manifest) {
        var step = Promise.resolve();
        if (choices.media_type === "video") {
            step = step.then(function () {
                return uploadVideoAsset(client, choices.job_id, exportResult.main_path, "main", manifest);
            });
        } else {
            step = step.then(function () {
                return client.uploadAsset(choices.job_id, "main",
                    readFileBytes(exportResult.main_path),
                    exportResult.main_path.split(/[\\/]/).pop(), manifest);
            });
        }
        if (exportResult.mask_path) {
            step = step.then(function () {
                if (choices.media_type === "video") {
                    return uploadVideoAsset(client, choices.job_id, exportResult.mask_path, "mask", manifest);
                }
                return client.uploadAsset(choices.job_id, "mask",
                    readFileBytes(exportResult.mask_path),
                    exportResult.mask_path.split(/[\\/]/).pop(), manifest);
            });
        }
        return step.then(function () {
            var required = ["main"];
            if (exportResult.mask_path) required.push("mask");
            return client.getJob(choices.job_id).then(function (job) {
                var missing = required.filter(function (a) { return !(job.assets && job.assets[a]); });
                if (missing.length) {
                    throw new Error("upload verification failed: missing asset(s) " + missing.join(", "));
                }
                panelLog("UPLOAD VERIFY", choices.job_id + " assets=" + required.join(","));
                return job;
            });
        });
    }

    // Write the downloaded result to disk. Video streams via Range chunks;
    // stills use the existing whole-file path (small).
    function downloadResultToPath(client, jobId, outPath, mediaType) {
        if (mediaType === "video") {
            var resultFs = nodeFs();
            return client.downloadResultChunked(jobId, function (offset, bytes) {
                if (resultFs) { writeChunkNode(outPath, offset, bytes); return null; }
                return writeChunkHost(outPath, offset, bytes);
            }, function (p) {
                setProgress(p.downloaded, p.total);
                throttledProgressLog("DOWNLOAD PROGRESS", jobId, p.downloaded, p.total);
            }, resultFs ? CHUNK_BYTES : HOST_CHUNK_BYTES).then(function (info) {
                panelLog("DOWNLOAD DONE", jobId + " total=" + info.total);
                return { outPath: outPath, meta: info.meta };
            });
        }
        return client.downloadResult(jobId).then(function (dl) {
            writeFileBytes(outPath, dl.bytes);
            return { outPath: outPath, meta: dl.meta };
        });
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
        if (typeof window.cep === "undefined" || !window.cep.fs) return;
        try {
            var res = window.cep.fs.showOpenDialogEx(false, true, "Choose folder", "", []);
            if (res.err === 0 && res.data && res.data.length) input.value = res.data[0];
        } catch (e) { /* dialog unavailable (tests) */ }
    }

    // --- status helpers -----------------------------------------------------

    function setStatus(el, msg, cls) {
        el.textContent = msg;
        el.className = cls || "";
    }

    function setProgress(value, max) {
        var bar = $("progress");
        var total = Number(max || 0);
        var done = Number(value || 0);
        bar.max = total > 0 ? total : 1;
        bar.value = total > 0 ? Math.max(0, Math.min(done, total)) : 0;
    }

    var runState = { running: false, jobId: null, client: null, cancelRequested: false };

    function setRunning(running) {
        runState.running = running;
        runState.cancelRequested = false;
        $("btn-queue").classList.toggle("hidden", running);
        $("btn-cancel").classList.toggle("hidden", !running);
        $("progress").classList.toggle("hidden", !running);
        setProgress(0, 1);
    }

    function checkCancelled() {
        if (runState.cancelRequested) throw new Error("cancelled");
    }

    // AE 26 / CEP 12 can initialize the DOM successfully but leave the panel
    // surface black. Toggling a compositor-only style forces CEF to invalidate
    // and repaint without changing layout or panel state.
    var repaintFlip = false;
    function forcePanelRepaint() {
        if (typeof document === "undefined" || !document.body) return;
        repaintFlip = !repaintFlip;
        document.body.style.webkitTransform = repaintFlip
            ? "translateZ(0)" : "translateZ(0.001px)";
        document.body.style.opacity = "0.9999";
        // Force style/layout evaluation before restoring full opacity.
        document.body.offsetHeight;
        setTimeout(function () {
            if (document.body) document.body.style.opacity = "1";
        }, 20);
    }

    function installRepaintRecovery() {
        forcePanelRepaint();
        setTimeout(forcePanelRepaint, 100);
        setTimeout(forcePanelRepaint, 500);
        if (typeof window.addEventListener === "function") {
            window.addEventListener("focus", forcePanelRepaint);
            window.addEventListener("resize", forcePanelRepaint);
        }
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) forcePanelRepaint();
        });
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
        "set-template-4444": "prores4444Template",
        "set-template-422hq": "prores422hqTemplate",
        "set-template-h264": "h264Template",
        "set-template-mask": "maskTemplate"
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
        var rf = $("result-folder").value.trim();
        if (rf) Settings.set("resultFolder", rf);
    }

    function saveSettings() {
        Object.keys(SETTING_FIELDS).forEach(function (id) {
            Settings.set(SETTING_FIELDS[id], $(id).value);
        });
        persistGenerateChoices();
        // Keep the Generate-tab result-folder field in sync with the
        // authoritative Settings value (persistGenerateChoices skips blanks).
        $("result-folder").value = Settings.get("resultFolder");
        setStatus($("status-settings"), "Settings saved.", "ok");
        checkConnection();
    }

    function formatTemplateSetup(result) {
        function names(items) {
            return items.map(function (item) { return item.name; }).join(", ");
        }
        var lines = [];
        if (result.created && result.created.length) {
            lines.push("Created: " + names(result.created));
        }
        if (result.ready && result.ready.length) {
            lines.push("Already ready: " + names(result.ready));
        }
        if (result.missing && result.missing.length) {
            lines.push("Missing: " + names(result.missing));
            lines.push("For AE2C ProRes 422 HQ: Edit > Templates > Output Module > New; " +
                "Format QuickTime; Format Options Apple ProRes 422 HQ; Channels RGB; " +
                "save exactly as 'AE2C ProRes 422 HQ', then run this audit again.");
        }
        lines.push("PNG/JPG still transport: no AE template required.");
        return lines.join("\n");
    }

    function setupTemplates() {
        var statusEl = $("status-settings");
        setStatus(statusEl, "Inspecting AE Output Module templates…");
        return hostCall("setupTemplatesJSON()")
            .then(function (result) {
                var hasMissing = result.missing && result.missing.length;
                setStatus(statusEl, formatTemplateSetup(result), hasMissing ? "err" : "ok");
                return result;
            })
            .catch(function (e) {
                var logHint = panelLogPath();
                setStatus(statusEl, "Template setup failed: " + e.message +
                    (logHint ? "\nLog: " + logHint : ""), "err");
                throw e;
            });
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
        var videoTemplate = vf === "mp4" ? Settings.get("h264Template")
            : (vf === "mov422" ? Settings.get("prores422hqTemplate")
                               : Settings.get("prores4444Template"));
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
            ame_main_template: videoTemplate,
            ame_mask_template: Settings.get("maskTemplate")
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
                        if (s.done) return resolve(s);
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

    function reconcileAmeOutput(exportResult, manifest, status) {
        var changes = [];
        if (!status) return changes;
        if (status.main_path && status.main_path !== exportResult.main_path) {
            changes.push("main path " + exportResult.main_path + " -> " + status.main_path);
            exportResult.main_path = status.main_path;
        }
        if (status.mask_path && status.mask_path !== exportResult.mask_path) {
            changes.push("mask path " + exportResult.mask_path + " -> " + status.mask_path);
            exportResult.mask_path = status.mask_path;
        }
        if (status.video_format && status.video_format !== manifest.video_format) {
            changes.push("source transport format " + status.video_format +
                " (requested result remains " + manifest.video_format + ")");
            manifest.source_video_format = status.video_format;
        }
        return changes;
    }

    function pollWorkflowCompat(workflowId, mediaType) {
        var opt = $("workflow").querySelector("option[value='" + workflowId + "']");
        var media = opt && opt.dataset ? opt.dataset.media : "";
        if (media && media !== "both" && media !== mediaType) {
            throw new Error("selected workflow is " + media + "-only; input is " + mediaType);
        }
    }

    // --- preflight ---------------------------------------------------------

    var objectInfoCache = { ts: 0, data: null };
    var OBJECT_INFO_TTL_MS = 60 * 1000;

    function getObjectInfo(client) {
        var now = Date.now();
        if (objectInfoCache.data && now - objectInfoCache.ts < OBJECT_INFO_TTL_MS) {
            return Promise.resolve(objectInfoCache.data);
        }
        return client.getObjectInfo()
            .then(function (info) {
                objectInfoCache.data = info;
                objectInfoCache.ts = now;
                return info;
            })
            .catch(function (e) {
                var err = new Error("object_info fetch failed: " + e.message);
                err.objectInfoUnavailable = true;
                throw err;
            });
    }

    /* Fetch + validate the workflow BEFORE any AE/AME render or upload.
     * workflow-validation errors are fatal; object_info unavailability
     * degrades to log-only (the workflow graph itself was still validated). */
    function preflightWorkflow(client, workflowId, choices) {
        panelLog("PREFLIGHT", "workflow " + workflowId + " media=" + choices.media_type +
            " mask=" + choices.mask_mode);
        return client.getWorkflowPrompt(workflowId)
            .then(function (wf) {
                var check = AE2CPatch.validateWorkflow(wf.prompt, choices.media_type, choices.mask_mode);
                if (check.errors.length) throw new Error(check.errors.join("; "));
                panelLog("PREFLIGHT OK", "workflow " + workflowId + " graph valid");
                return wf;
            })
            .then(function (wf) {
                return getObjectInfo(client)
                    .then(function (info) {
                        // Validate required inputs after applying the fields the
                        // bridge injects at queue time. This still runs before
                        // export, using an empty provisional manifest.
                        var preflightPrompt = AE2CPatch.patchWorkflow(wf.prompt, {
                            job_id: choices.job_id,
                            asset_id: "main",
                            prompt_text: choices.prompt,
                            manifest: {},
                            video_format: choices.video_format,
                            mov_codec: choices.mov_codec
                        }).prompt;
                        var check = AE2CPatch.validateNodeInputs(preflightPrompt, info);
                        if (check.errors.length) {
                            throw new Error("workflow input validation: " + check.errors.join("; "));
                        }
                        if (check.unknown.length) {
                            panelLog("PREFLIGHT UNKNOWN NODES", check.unknown.join(", "));
                        }
                        return { wf: wf, objectInfo: info };
                    })
                    .catch(function (e) {
                        if (e && e.objectInfoUnavailable) {
                            panelLog("PREFLIGHT DEGRADED", e.message);
                            return { wf: wf, objectInfo: null };
                        }
                        throw e;
                    });
            });
    }


    function runGenerate() {
        var statusEl = $("status");
        var choices, workflowId, workflow, exportResult, manifest, client;
        try {
            choices = gatherChoices();
            choices.resultFolder = $("result-folder").value.trim() || Settings.get("resultFolder");
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

        // Preflight (workflow fetch + validation) happens before any AE/AME
        // render or upload; a broken workflow must not waste a render.
        preflightWorkflow(client, workflowId, choices)
            .then(function (pre) {
                workflow = pre.wf;
                setStatus(statusEl, "Reading comp context…");
                return hostCall("getContextJSON()");
            })
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
                panelLog("EXPORT RANGE", "job=" + choices.job_id + " range_source=" +
                    manifest.range_source + " start=" + manifest.timeline_start_seconds +
                    " duration=" + manifest.duration_seconds);
                if (exp.color_applied === false) {
                    setStatus(statusEl, "Warning: output-module color settings " +
                        "were not applied (unsupported AE version) — verify " +
                        "colors manually.");
                }
                if (choices.media_type === "video") return waitForAmeExport(choices);
            })
            .then(function (ameStatus) {
                if (choices.media_type === "video") {
                    var ameChanges = reconcileAmeOutput(exportResult, manifest, ameStatus);
                    if (ameChanges.length) {
                        panelLog("AME OUTPUT ADJUSTED", ameChanges.join("; "));
                    }
                }
                checkCancelled();
                setStatus(statusEl, "Uploading assets…");
                setProgress(0, 1);
                return uploadAssets(client, choices, exportResult, manifest);
            })
            .then(function () {
                checkCancelled();
                setStatus(statusEl, "Patching workflow…");
                var patched = AE2CPatch.patchWorkflow(workflow.prompt, {
                    job_id: choices.job_id,
                    asset_id: "main",
                    prompt_text: choices.prompt,
                    manifest: manifest,
                    video_format: choices.video_format,
                    mov_codec: choices.mov_codec
                });
                setStatus(statusEl, "Queueing in ComfyUI…");
                return client.queuePrompt(patched.prompt, workflow.client_id);
            })
            .then(function (q) {
                setStatus(statusEl, "ComfyUI running…");
                setProgress(0, 1);
                return client.waitForCompletion(q.prompt_id, function (p) {
                    if (p.pending) {
                        setStatus(statusEl, "In ComfyUI queue…");
                    } else if (p.max > 0) {
                        setProgress(p.value, p.max);
                        var pct = Math.round(100 * p.value / p.max);
                        setStatus(statusEl, "ComfyUI rendering… " + pct + "%" +
                            (p.node !== null && p.node !== undefined
                                ? " (node " + p.node + ")" : ""));
                    } else if (p.running) {
                        setStatus(statusEl, "ComfyUI rendering…" +
                            (p.node !== null && p.node !== undefined
                                ? " node " + p.node : ""));
                    }
                }, 2000, workflow.client_id);
            })
            .then(function () {
                checkCancelled();
                setStatus(statusEl, "Downloading result…");
                setProgress(0, 1);
                var ext = choices.media_type === "video"
                    ? choices.video_format : choices.image_format;
                var outDir = pathJoin(choices.resultFolder, choices.job_id);
                ensureDir(outDir);
                var outPath = pathJoin(outDir, "result." + ext);
                return downloadResultToPath(client, choices.job_id, outPath, choices.media_type)
                    .then(function (r) {
                        if (choices.media_type === "video" && r.meta && r.meta.format &&
                                r.meta.format !== choices.video_format) {
                            throw new Error("ComfyUI returned " + r.meta.format.toUpperCase() +
                                " but the AE panel requested " +
                                choices.video_format.toUpperCase());
                        }
                        setStatus(statusEl, "Importing into comp…");
                        return hostCall("importResult(" + JSON.stringify(JSON.stringify({
                            manifest: manifest,
                            result_path: r.outPath
                        })) + ")").then(function (imp) {
                            return { outPath: r.outPath, imp: imp };
                        });
                    });
            })
            .then(function (r) {
                setStatus(statusEl,
                    "Done: " + r.outPath + "\nPlaced layer \"" + r.imp.layer_name +
                    "\" at " + Number(r.imp.placed_at_seconds).toFixed(3) + "s.", "ok");
            })
            .catch(function (e) {
                var msg = (e && e.message) || String(e);
                panelLog("GENERATE ERROR", msg);
                var logHint = panelLogPath();
                setStatus(statusEl, msg === "cancelled" ? "Cancelled." : "Error: " + msg +
                    (logHint ? "\nLog: " + logHint : ""),
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
        installRepaintRecovery();
        $("tab-generate").addEventListener("click", function () { showTab("generate"); });
        $("tab-settings").addEventListener("click", function () { showTab("settings"); });
        $("btn-save-settings").addEventListener("click", saveSettings);
        $("btn-setup-templates").addEventListener("click", function () {
            setupTemplates().catch(function () {});
        });
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
        panelLog("PANEL INIT", "extension=" + extensionRoot() + " log=" + panelLogPath());
        syncMediaRows();
        checkConnection();
        refreshWorkflows();
    }

    // Skip bootstrap in Node test environments (no DOM).
    if (typeof document !== "undefined" && typeof window !== "undefined") {
        document.addEventListener("DOMContentLoaded", init);
    }

    // --- Node test exports ------------------------------------------------
    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            browseFolder: browseFolder,
            persistGenerateChoices: persistGenerateChoices,
            saveSettings: saveSettings,
            formatTemplateSetup: formatTemplateSetup,
            gatherChoices: gatherChoices,
            validateChoices: validateChoices,
            extensionRoot: extensionRoot,
            bootstrapHost: bootstrapHost,
            ensureHost: ensureHost,
            hostCall: hostCall,
            panelLogPath: panelLogPath,
            reconcileAmeOutput: reconcileAmeOutput,
            checksumBytes: checksumBytes,
            forcePanelRepaint: forcePanelRepaint,
            resetHostForTests: function () { hostReadyPromise = null; }
        };
    }
})();
