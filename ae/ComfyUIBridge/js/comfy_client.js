/* AE2ComfyUI ComfyUI HTTP client.
 *
 * Runs in the CEP panel (browser fetch) and in Node tests (inject fetchImpl).
 * File bytes are passed in by the caller so CEP can use cep.fs and tests can
 * use Node fs — this module stays transport-pure.
 *
 * Large videos move through the chunked begin/chunk/finish upload protocol and
 * Range-based chunked download; the caller supplies readChunk/writeChunk so
 * this module never base64-loads or buffers a whole video.
 */
(function (root) {
    "use strict";

    var DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB per request body

    function ComfyClient(baseUrl, fetchImpl) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this._fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
        if (!this._fetch) throw new Error("no fetch implementation available");
    }

    /* Format a ComfyUI/PromptServer error JSON into a readable line, keeping
     * node_errors (validation failures) legible per node. */
    function formatServerError(data, status) {
        var err = data && data.error;
        if (!err) return "HTTP " + (status || 0);
        if (typeof err === "string") return err;
        if (typeof err === "object") {
            var parts = [];
            if (err.type) parts.push(String(err.type));
            if (err.message) parts.push(String(err.message));
            var extra = err.extra_info || {};
            var nodeErrors = extra.node_errors;
            if (nodeErrors && typeof nodeErrors === "object") {
                var ids = Object.keys(nodeErrors);
                if (ids.length) {
                    var lines = [];
                    for (var i = 0; i < ids.length; i++) {
                        var ne = nodeErrors[ids[i]];
                        var what = (ne && ne.class_type) ? (ids[i] + " (" + ne.class_type + ")") : ids[i];
                        var why = (ne && ne.errors && ne.errors.length)
                            ? ne.errors.join("; ")
                            : ((ne && ne.message) || "invalid node input");
                        lines.push("node " + what + ": " + why);
                    }
                    parts.push(lines.join(" | "));
                }
            }
            if (err.details) parts.push(String(err.details));
            return parts.length ? parts.join(": ") : JSON.stringify(err);
        }
        return String(err);
    }

    ComfyClient.prototype._json = function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
            if (!resp.ok) {
                throw new Error(formatServerError(data, resp.status));
            }
            return data;
        });
    };

    ComfyClient.prototype.health = function () {
        return this._fetch(this.baseUrl + "/ae_bridge/health", { cache: "no-store" })
            .then(this._json);
    };

    ComfyClient.prototype.getWorkflows = function () {
        return this._fetch(this.baseUrl + "/ae_bridge/workflows", { cache: "no-store" })
            .then(this._json)
            .then(function (data) { return data.workflows || []; });
    };

    /* Node class definitions from ComfyUI, keyed by class_type. */
    ComfyClient.prototype.getObjectInfo = function () {
        return this._fetch(this.baseUrl + "/object_info", { cache: "no-store" })
            .then(this._json);
    };

    ComfyClient.prototype.getJob = function (jobId) {
        return this._fetch(this.baseUrl + "/ae_bridge/jobs/" +
                encodeURIComponent(jobId), { cache: "no-store" })
            .then(this._json);
    };

    /* fileBytes: Uint8Array | Buffer; filename used only for extension. */
    ComfyClient.prototype.uploadAsset = function (jobId, assetId, fileBytes, filename, metadata) {
        var form = new FormData();
        form.append("job_id", jobId);
        form.append("asset_id", assetId);
        form.append("metadata", JSON.stringify(metadata || {}));
        form.append("file", new Blob([fileBytes]), filename || (assetId + ".bin"));
        return this._fetch(this.baseUrl + "/ae_bridge/assets", {
            method: "POST", body: form
        }).then(this._json);
    };

    ComfyClient.prototype.getWorkflowPrompt = function (workflowId) {
        return this._fetch(this.baseUrl + "/ae_bridge/run_workflow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow_id: workflowId })
        }).then(this._json);
    };

    ComfyClient.prototype.queuePrompt = function (prompt, clientId) {
        return this._fetch(this.baseUrl + "/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: prompt, client_id: clientId })
        }).then(this._json);
    };

    ComfyClient.prototype.getHistory = function (promptId) {
        return this._fetch(this.baseUrl + "/history/" + encodeURIComponent(promptId),
            { cache: "no-store" }).then(this._json);
    };

    ComfyClient.prototype.interrupt = function () {
        return this._fetch(this.baseUrl + "/interrupt", { method: "POST" })
            .then(this._json);
    };

    /* Stream a large file to the server with bounded memory.
     *
     * fileSize: total bytes; readChunk(offset, size) -> Uint8Array (or a
     * Promise of one); onProgress({uploaded, total}) is throttled by caller.
     * Resolves with the finish response. */
    ComfyClient.prototype.uploadAssetChunked = function (jobId, assetId, fileSize, filename, metadata, readChunk, onProgress, chunkSizeBytes) {
        var self = this;
        var chunkSize = chunkSizeBytes || DEFAULT_CHUNK_BYTES;
        var base = this.baseUrl + "/ae_bridge/assets/";
        return this._fetch(base + "begin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                job_id: jobId, asset_id: assetId, filename: filename || (assetId + ".bin"),
                size: fileSize, metadata: metadata || {}
            })
        }).then(this._json).then(function () {
            var offset = 0;
            function sendNext() {
                if (offset >= fileSize) return null;
                var size = Math.min(chunkSize, fileSize - offset);
                return Promise.resolve(readChunk(offset, size)).then(function (bytes) {
                    if (!bytes || !bytes.length) throw new Error("readChunk returned no bytes at " + offset);
                    return self._fetch(base + "chunk?job_id=" + encodeURIComponent(jobId) +
                        "&asset_id=" + encodeURIComponent(assetId) + "&offset=" + offset, {
                        method: "POST",
                        headers: { "Content-Type": "application/octet-stream" },
                        body: bytes
                    }).then(self._json).then(function () {
                        offset += bytes.length;
                        if (onProgress) onProgress({ uploaded: offset, total: fileSize });
                        return sendNext();
                    });
                });
            }
            return sendNext();
        }).then(function () {
            return self._fetch(base + "finish", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ job_id: jobId, asset_id: assetId, size: fileSize })
            }).then(self._json);
        });
    };

    /* Download a result via Range requests without buffering the whole file.
     *
     * writeChunk(offset, bytes) must return a Promise or undefined;
     * onProgress({downloaded, total}) is throttled by caller. Resolves
     * {meta, total}. */
    ComfyClient.prototype.downloadResultChunked = function (jobId, writeChunk, onProgress, chunkSizeBytes) {
        var self = this;
        var chunkSize = chunkSizeBytes || DEFAULT_CHUNK_BYTES;
        var url = this.baseUrl + "/ae_bridge/jobs/" + encodeURIComponent(jobId) + "/result";
        function parseMeta(resp) {
            var h = resp.headers;
            return {
                format: h.get("X-AEBridge-Format") || "",
                width: parseInt(h.get("X-AEBridge-Width") || "0", 10),
                height: parseInt(h.get("X-AEBridge-Height") || "0", 10),
                frameCount: parseInt(h.get("X-AEBridge-Frame-Count") || "0", 10),
                fps: parseFloat(h.get("X-AEBridge-FPS") || "0"),
                duration: parseFloat(h.get("X-AEBridge-Duration") || "0")
            };
        }
        // Probe with a 1-byte Range to learn the total size from Content-Range.
        return this._fetch(url, { cache: "no-store", headers: { "Range": "bytes=0-0" } })
            .then(function (resp) {
                if (!resp.ok && resp.status !== 206) {
                    throw new Error("result not ready (HTTP " + resp.status + ")");
                }
                var cr = resp.headers.get("Content-Range") || "";
                var m = /bytes\s+0-0\/(\d+)/.exec(cr);
                var total = m ? parseInt(m[1], 10) : 0;
                var meta = parseMeta(resp);
                return resp.arrayBuffer().then(function () { return { total: total, meta: meta }; });
            })
            .then(function (info) {
                if (!info.total) throw new Error("cannot determine result size (no Content-Range header)");
                var offset = 0;
                function next() {
                    if (offset >= info.total) return info.meta;
                    var end = Math.min(offset + chunkSize - 1, info.total - 1);
                    return self._fetch(url, {
                        cache: "no-store",
                        headers: { "Range": "bytes=" + offset + "-" + end }
                    }).then(function (resp) {
                        if (!resp.ok && resp.status !== 206) {
                            throw new Error("result download failed (HTTP " + resp.status + ")");
                        }
                        return resp.arrayBuffer().then(function (buf) {
                            var bytes = new Uint8Array(buf);
                            return Promise.resolve(writeChunk(offset, bytes)).then(function () {
                                offset += bytes.length;
                                if (onProgress) onProgress({ downloaded: offset, total: info.total });
                                return next();
                            });
                        });
                    });
                }
                return next().then(function (meta) {
                    return { meta: meta, total: info.total };
                });
            });
    };

    /* Resolves {bytes: Uint8Array, meta: {format,width,height,frameCount,fps,duration}}. */
    ComfyClient.prototype.downloadResult = function (jobId) {
        return this._fetch(this.baseUrl + "/ae_bridge/jobs/" +
                encodeURIComponent(jobId) + "/result", { cache: "no-store" })
            .then(function (resp) {
                if (!resp.ok) throw new Error("result not ready (HTTP " + resp.status + ")");
                var h = resp.headers;
                var meta = {
                    format: h.get("X-AEBridge-Format") || "",
                    width: parseInt(h.get("X-AEBridge-Width") || "0", 10),
                    height: parseInt(h.get("X-AEBridge-Height") || "0", 10),
                    frameCount: parseInt(h.get("X-AEBridge-Frame-Count") || "0", 10),
                    fps: parseFloat(h.get("X-AEBridge-FPS") || "0"),
                    duration: parseFloat(h.get("X-AEBridge-Duration") || "0")
                };
                return resp.arrayBuffer().then(function (buf) {
                    return { bytes: new Uint8Array(buf), meta: meta };
                });
            });
    };

    /* Poll /history until the prompt appears with status, calling
     * onProgress({running}) each tick. Rejects on error status. */
    ComfyClient.prototype.waitForCompletion = function (promptId, onProgress, intervalMs) {
        var self = this;
        var interval = intervalMs || 2000;
        return new Promise(function (resolve, reject) {
            function tick() {
                self.getHistory(promptId).then(function (hist) {
                    var entry = hist && hist[promptId];
                    if (!entry) {
                        if (onProgress) onProgress({ pending: true });
                        return setTimeout(tick, interval);
                    }
                    var status = entry.status || {};
                    if (status.completed) return resolve(entry);
                    if (status.status_str === "error" || status.status === "error") {
                        var msgs = (status.messages || []).map(function (m) {
                            return Array.isArray(m) ? (m[1] && (m[1].exception_message || m[1].error)) : m;
                        }).filter(Boolean).join("; ");
                        return reject(new Error(msgs || "ComfyUI execution error"));
                    }
                    if (onProgress) onProgress({ running: true, status: status });
                    setTimeout(tick, interval);
                }).catch(reject);
            }
            tick();
        });
    };

    root.ComfyClient = ComfyClient;
    ComfyClient.formatServerError = formatServerError;
    if (typeof module !== "undefined" && module.exports) module.exports = ComfyClient;
})(typeof window !== "undefined" ? window : globalThis);
