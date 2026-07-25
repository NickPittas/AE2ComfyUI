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

    console.log("test_comfy_client.js: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
