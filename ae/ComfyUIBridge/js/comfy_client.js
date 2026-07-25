/* AE2ComfyUI ComfyUI HTTP client.
 *
 * Runs in the CEP panel (browser fetch) and in Node tests (inject fetchImpl).
 * File bytes are passed in by the caller so CEP can use cep.fs and tests can
 * use Node fs — this module stays transport-pure.
 */
(function (root) {
    "use strict";

    function ComfyClient(baseUrl, fetchImpl) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this._fetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(root) : null);
        if (!this._fetch) throw new Error("no fetch implementation available");
    }

    ComfyClient.prototype._json = function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
            if (!resp.ok) {
                var msg = (data && data.error) || ("HTTP " + resp.status);
                throw new Error(msg);
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
    if (typeof module !== "undefined" && module.exports) module.exports = ComfyClient;
})(typeof window !== "undefined" ? window : globalThis);
