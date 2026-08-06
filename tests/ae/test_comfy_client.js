/* Node tests for comfy_client.js with a mocked fetch. Run: node tests/ae/test_comfy_client.js */
"use strict";
const assert = require("assert");
const ComfyClient = require("../../ae/ComfyUIBridge/js/comfy_client.js");

function mockFetch(handlers) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url, opts });
        for (const h of handlers) {
            if (url.includes(h.match) && (!h.method || (opts.method || "GET") === h.method)) {
                return h.response;
            }
        }
        throw new Error("no mock for " + url);
    };
    fn.calls = calls;
    return fn;
}

function jsonResp(data, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k] || null },
        json: async () => data
    };
}

(async () => {
    // health
    let fetch = mockFetch([
        { match: "/ae_bridge/health", response: jsonResp({ ok: true, app: "ae2comfyui" }) }
    ]);
    let client = new ComfyClient("http://127.0.0.1:8188/", fetch);
    let h = await client.health();
    assert.strictEqual(h.app, "ae2comfyui");
    // trailing slash trimmed
    assert.strictEqual(fetch.calls[0].url, "http://127.0.0.1:8188/ae_bridge/health");

    // workflows
    fetch = mockFetch([
        { match: "/ae_bridge/workflows", response: jsonResp({ ok: true, workflows: [{ id: "saved:a.json" }] }) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    const wfs = await client.getWorkflows();
    assert.strictEqual(wfs.length, 1);

    // upload asset: verify multipart fields reach FormData
    fetch = mockFetch([
        { match: "/ae_bridge/assets", method: "POST", response: jsonResp({ ok: true, path: "/tmp/x/main.png" }) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    const up = await client.uploadAsset("job1", "main", new Uint8Array([1, 2, 3]), "main.png", { w: 8 });
    assert.strictEqual(up.path, "/tmp/x/main.png");
    const body = fetch.calls[0].opts.body;
    assert.ok(body instanceof FormData, "FormData body");
    assert.strictEqual(body.get("job_id"), "job1");
    assert.strictEqual(body.get("asset_id"), "main");
    assert.strictEqual(JSON.parse(body.get("metadata")).w, 8);
    assert.ok(body.get("file"), "file field present");

    // queue prompt
    fetch = mockFetch([
        { match: "/prompt", method: "POST", response: jsonResp({ prompt_id: "pid-1" }) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    const q = await client.queuePrompt({ "1": {} }, "cid");
    assert.strictEqual(q.prompt_id, "pid-1");
    assert.strictEqual(JSON.parse(fetch.calls[0].opts.body).client_id, "cid");

    // download result: headers parsed
    const ab = new Uint8Array([9, 9]).buffer;
    fetch = mockFetch([{
        match: "/ae_bridge/jobs/job1/result",
        response: {
            ok: true, status: 200,
            headers: { get: (k) => ({
                "X-AEBridge-Format": "mov", "X-AEBridge-Width": "64",
                "X-AEBridge-Height": "64", "X-AEBridge-Frame-Count": "8",
                "X-AEBridge-FPS": "24", "X-AEBridge-Duration": "0.3333"
            })[k] || null },
            arrayBuffer: async () => ab
        }
    }]);
    client = new ComfyClient("http://h:1", fetch);
    const dl = await client.downloadResult("job1");
    assert.strictEqual(dl.meta.format, "mov");
    assert.strictEqual(dl.meta.frameCount, 8);
    assert.strictEqual(dl.bytes.length, 2);

    // waitForCompletion: pending then completed
    let ticks = 0;
    fetch = mockFetch([{
        match: "/history/pid-9",
        response: { ok: true, status: 200, headers: { get: () => null },
            json: async () => (++ticks >= 2
                ? { "pid-9": { status: { completed: true } } }
                : {}) }
    }]);
    client = new ComfyClient("http://h:1", fetch);
    const entry = await client.waitForCompletion("pid-9", null, 5);
    assert.strictEqual(entry.status.completed, true);
    assert.ok(ticks >= 2);

    // waitForCompletion: error surfaced
    fetch = mockFetch([{
        match: "/history/pid-e",
        response: { ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ "pid-e": { status: { status_str: "error",
                messages: [["execution_error", { exception_message: "node boom" }]] } } }) }
    }]);
    client = new ComfyClient("http://h:1", fetch);
    await assert.rejects(() => client.waitForCompletion("pid-e", null, 5), /node boom/);

    // error path: non-ok response with error field
    fetch = mockFetch([
        { match: "/ae_bridge/health", response: jsonResp({ ok: false, error: "broken" }, 500) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    await assert.rejects(() => client.health(), /broken/);

    // error path: ComfyUI validation node_errors formatted readably
    fetch = mockFetch([
        { match: "/prompt", method: "POST", response: jsonResp({ ok: false,
            error: { type: "validation", message: "prompt contains errors",
                extra_info: { node_errors: {
                    "3": { class_type: "KSampler", errors: ["value not in list"] },
                    "7": { class_type: "LoadImage", message: "boom" }
                } } } }, 400) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    await assert.rejects(() => client.queuePrompt({}, "cid"), /node 3 \(KSampler\): value not in list.*node 7 \(LoadImage\): boom/);

    // getObjectInfo
    fetch = mockFetch([
        { match: "/object_info", response: jsonResp({ KSampler: { input: { required: {} } } }) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    const objInfo = await client.getObjectInfo();
    assert.ok(objInfo.KSampler, "object_info returned");

    // getJob
    fetch = mockFetch([
        { match: "/ae_bridge/jobs/job9", response: jsonResp({ ok: true, assets: { main: "main.mov" } }) }
    ]);
    client = new ComfyClient("http://h:1", fetch);
    const job = await client.getJob("job9");
    assert.deepStrictEqual(job.assets, { main: "main.mov" });

    // uploadAssetChunked: mocked fetch reassembles exact bytes
    const uploadBytes = new Uint8Array((4 * 1024 * 1024) + 1234).map((_, i) => i % 251);
    const uploadReceived = {};
    const uploadCalls = [];
    const uploadMock = async (url, opts = {}) => {
        uploadCalls.push({ url, method: opts.method || "GET" });
        if (url.includes("/assets/begin")) return jsonResp({ ok: true, size: uploadBytes.length });
        if (url.includes("/assets/chunk")) {
            const m = /offset=(\d+)/.exec(url);
            uploadReceived[Number(m[1])] = new Uint8Array(opts.body);
            return jsonResp({ ok: true });
        }
        if (url.includes("/assets/finish")) {
            const body = JSON.parse(opts.body);
            return jsonResp({ ok: true, size: body.size, path: "/tmp/x/main.mov" });
        }
        throw new Error("no mock for " + url);
    };
    const readChunk = (offset, size) => uploadBytes.slice(offset, offset + size);
    let uploadProgress = [];
    client = new ComfyClient("http://h:1", uploadMock);
    const upRes = await client.uploadAssetChunked(
        "jobc", "main", uploadBytes.length, "main.mov", { w: 8 }, readChunk,
        (p) => uploadProgress.push(p.uploaded));
    assert.strictEqual(upRes.size, uploadBytes.length);
    assert.ok(uploadCalls.some((c) => c.url.includes("/assets/begin")), "begin called");
    assert.ok(uploadCalls.some((c) => c.url.includes("/assets/finish")), "finish called");
    // all offsets covered, no gaps, no overlaps
    const offsets = Object.keys(uploadReceived).map(Number).sort((a, b) => a - b);
    assert.strictEqual(offsets[0], 0, "first chunk at offset 0");
    for (let i = 1; i < offsets.length; i++) {
        assert.strictEqual(offsets[i], offsets[i - 1] + uploadReceived[offsets[i - 1]].length,
            "chunks are contiguous");
    }
    const reassembled = new Uint8Array(uploadBytes.length);
    for (const [off, bytes] of Object.entries(uploadReceived)) reassembled.set(bytes, Number(off));
    assert.deepStrictEqual(reassembled, uploadBytes, "upload bytes reassembled exactly");
    assert.strictEqual(uploadProgress[uploadProgress.length - 1], uploadBytes.length,
        "progress reaches total");

    // downloadResultChunked: Range requests reassemble exact bytes
    const dlBytes = new Uint8Array((2 * 1024 * 1024) + 777).map((_, i) => (i * 13) % 256);
    const dlMeta = { format: "mov", width: "64", height: "64", frameCount: "8", fps: "24", duration: "0.3333" };
    const downloadMock = async (url, opts = {}) => {
        const range = (opts.headers || {}).Range || "";
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        if (!m) throw new Error("missing Range header");
        const start = Number(m[1]), end = Number(m[2]);
        const slice = dlBytes.slice(start, end + 1);
        const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        return {
            ok: true, status: 206,
            headers: { get: (k) => ({
                "Content-Range": `bytes ${start}-${end}/${dlBytes.length}`,
                "X-AEBridge-Format": dlMeta.format, "X-AEBridge-Width": dlMeta.width,
                "X-AEBridge-Height": dlMeta.height, "X-AEBridge-Frame-Count": dlMeta.frameCount,
                "X-AEBridge-FPS": dlMeta.fps, "X-AEBridge-Duration": dlMeta.duration
            })[k] || null },
            arrayBuffer: async () => ab
        };
    };
    const dlReceived = new Uint8Array(dlBytes.length);
    const writeChunk = (offset, bytes) => { dlReceived.set(bytes, offset); return Promise.resolve(); };
    client = new ComfyClient("http://h:1", downloadMock);
    const dlC = await client.downloadResultChunked("jobv", writeChunk, null, 512 * 1024);
    assert.strictEqual(dlC.total, dlBytes.length);
    assert.strictEqual(dlC.meta.format, "mov");
    assert.strictEqual(dlC.meta.frameCount, 8);
    assert.deepStrictEqual(dlReceived, dlBytes, "download bytes reassembled exactly");

    console.log("test_comfy_client.js: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
