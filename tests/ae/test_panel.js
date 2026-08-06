/* Node test for panel.js (browseFolder, persistGenerateChoices).
   Run: node tests/ae/test_panel.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Load Settings first so it's on globalThis before panel loads.
const Settings = require("../../ae/ComfyUIBridge/js/settings.js");

// Minimal DOM stub.
const elements = {};
global.document = {
    getElementById: function (id) {
        if (!elements[id]) {
            elements[id] = { value: "", classList: { toggle: function () {} } };
        }
        return elements[id];
    },
    addEventListener: function () {}
};

// Window stub. Default: no CEP → browseFolder must be a silent no-op.
global.window = {
    cep: undefined,
    crypto: { randomUUID: function () { return "00000000-0000-4000-8000-000000000000"; } },
    __adobe_cep__: undefined
};

// Load panel (stubs must be in place first).
const panel = require("../../ae/ComfyUIBridge/js/panel.js");

function el(id) { return document.getElementById(id); }

assert.strictEqual(panel.checksumBytes(new Uint8Array([0, 1, 254, 255])), 510,
    "bounded host chunk checksum covers binary edge bytes");

// ---------------------------------------------------------------------------
// AME may rewrite the requested container extension (for example MOV -> MP4).
// The panel must upload the file AME actually produced and keep metadata honest.
// ---------------------------------------------------------------------------
{
    const exported = { main_path: "/tmp/job/main.mov", mask_path: "/tmp/job/mask.mp4" };
    const manifest = { video_format: "mov" };
    const changes = panel.reconcileAmeOutput(exported, manifest, {
        main_path: "/tmp/job/main.mp4",
        mask_path: "/tmp/job/mask.mp4",
        video_format: "mp4"
    });
    assert.strictEqual(exported.main_path, "/tmp/job/main.mp4");
    assert.strictEqual(exported.mask_path, "/tmp/job/mask.mp4");
    assert.strictEqual(manifest.video_format, "mp4");
    assert.strictEqual(changes.length, 2);
}

// ---------------------------------------------------------------------------
// browseFolder — no CEP runtime
// ---------------------------------------------------------------------------
{
    const input = { value: "unchanged" };
    global.window.cep = undefined;
    panel.browseFolder(input);
    assert.strictEqual(input.value, "unchanged", "no CEP: silent no-op, input unchanged");
}

// ---------------------------------------------------------------------------
// browseFolder — cancel / empty data
// ---------------------------------------------------------------------------
{
    const input = { value: "unchanged" };
    global.window.cep = {
        fs: { showOpenDialogEx: function () { return { err: 0, data: [] }; } }
    };
    panel.browseFolder(input);
    assert.strictEqual(input.value, "unchanged", "empty data: input unchanged");
}

// ---------------------------------------------------------------------------
// browseFolder — error result
// ---------------------------------------------------------------------------
{
    const input = { value: "unchanged" };
    global.window.cep = {
        fs: { showOpenDialogEx: function () { return { err: 1, data: [] }; } }
    };
    panel.browseFolder(input);
    assert.strictEqual(input.value, "unchanged", "err != 0: input unchanged");
}

// ---------------------------------------------------------------------------
// browseFolder — success, path with spaces
// ---------------------------------------------------------------------------
{
    const input = { value: "unchanged" };
    global.window.cep = {
        fs: { showOpenDialogEx: function () { return { err: 0, data: ["/Users/test/my folder"] }; } }
    };
    panel.browseFolder(input);
    assert.strictEqual(input.value, "/Users/test/my folder", "success: first path assigned");
}

// ---------------------------------------------------------------------------
// persistGenerateChoices — empty result-folder preserves Settings value
// ---------------------------------------------------------------------------
{
    Settings.reset();
    Settings.set("resultFolder", "/settings/result");
    el("result-folder").value = "";
    el("image-format").value = "png";
    el("video-format").value = "mp4";
    el("color-mode").value = "preserve_working_space";
    el("placement").value = "above_selected_layer";

    panel.persistGenerateChoices();
    assert.strictEqual(Settings.get("resultFolder"), "/settings/result",
        "empty result-folder: Settings value preserved");
}

// ---------------------------------------------------------------------------
// persistGenerateChoices — whitespace-only result-folder preserves Settings
// ---------------------------------------------------------------------------
{
    Settings.reset();
    Settings.set("resultFolder", "/settings/result");
    el("result-folder").value = "   \t  ";
    el("image-format").value = "png";
    el("video-format").value = "mp4";
    el("color-mode").value = "preserve_working_space";
    el("placement").value = "above_selected_layer";

    panel.persistGenerateChoices();
    assert.strictEqual(Settings.get("resultFolder"), "/settings/result",
        "whitespace-only result-folder: Settings value preserved");
}

// ---------------------------------------------------------------------------
// persistGenerateChoices — non-blank result-folder is persisted
// ---------------------------------------------------------------------------
{
    Settings.reset();
    el("result-folder").value = "/generate/tab/folder";
    el("image-format").value = "png";
    el("video-format").value = "mp4";
    el("color-mode").value = "preserve_working_space";
    el("placement").value = "above_selected_layer";

    panel.persistGenerateChoices();
    assert.strictEqual(Settings.get("resultFolder"), "/generate/tab/folder",
        "non-blank result-folder: persisted");
}

console.log("test_panel.js: all assertions passed");

// ---------------------------------------------------------------------------
// template setup result formatting
// ---------------------------------------------------------------------------
{
    const message = panel.formatTemplateSetup({
        created: [{ name: "AE2C ProRes 4444" }],
        ready: [{ name: "AE2C H.264 15 Mbps" }],
        missing: [{ name: "AE2C ProRes 422 HQ" }]
    });
    assert.ok(message.indexOf("Created: AE2C ProRes 4444") !== -1);
    assert.ok(message.indexOf("Already ready: AE2C H.264 15 Mbps") !== -1);
    assert.ok(message.indexOf("Missing: AE2C ProRes 422 HQ") !== -1);
    assert.ok(message.indexOf("Apple ProRes 422 HQ") !== -1);
    assert.ok(message.indexOf("no AE template required") !== -1);
}

// ---------------------------------------------------------------------------
// host bootstrap and gating
// ---------------------------------------------------------------------------
(async function () {
    const scripts = [];
    const testFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ae2c-panel-test-"));
    Settings.set("stagingFolder", testFolder);
    global.window.__adobe_cep__ = {
        getSystemPath: function (kind) {
            assert.strictEqual(kind, "extension");
            return "/tmp/AE2ComfyUI%20extension";
        },
        evalScript: function (script, done) {
            scripts.push(script);
            const fileLiterals = script.match(/new File\(("(?:\\.|[^"])*")\)/g) || [];
            const responseLiteral = fileLiterals.map(function (match) {
                return match.slice("new File(".length, -1);
            }).find(function (literal) {
                return JSON.parse(literal).indexOf(".ae2c-host-response-") !== -1;
            });
            if (responseLiteral) {
                const responsePath = JSON.parse(responseLiteral);
                const response = script.indexOf("$.evalFile") !== -1
                    ? '{"ok":true,"loaded":true}'
                    : '{"ok":true,"value":"host-result"}';
                fs.writeFileSync(responsePath, response, "utf8");
            }
            // Reproduce the live AE 26 / CEP 12 problem: execution succeeds but
            // the CEP callback contains no result.
            done("");
        }
    };
    panel.resetHostForTests();

    const results = await Promise.all([
        panel.hostCall("getContextJSON()"),
        panel.hostCall("manifestFieldsJSON()")
    ]);
    assert.strictEqual(results[0].value, "host-result");
    assert.strictEqual(results[1].value, "host-result");
    assert.strictEqual(scripts.filter(function (s) { return s.indexOf("$.evalFile") !== -1; }).length, 1,
        "concurrent host calls share one bootstrap");
    assert.ok(scripts.filter(function (s) { return s.indexOf("/tmp/AE2ComfyUI extension/jsx/host.jsx") !== -1; }).length === 1,
        "bootstrap loads host.jsx from the extension root");
    assert.strictEqual(scripts.filter(function (s) { return s.indexOf("AE2C.getContextJSON()") !== -1; }).length, 1);
    assert.strictEqual(scripts.filter(function (s) { return s.indexOf("AE2C.manifestFieldsJSON()") !== -1; }).length, 1);
    assert.strictEqual(fs.readdirSync(testFolder).filter(function (name) {
        return name.indexOf(".ae2c-host-response-") === 0;
    }).length, 0, "host response files are removed after reading");

    console.log("test_panel.js: host bootstrap assertions passed");
    fs.rmSync(testFolder, { recursive: true, force: true });
})().catch(function (err) {
    console.error(err.stack || err);
    process.exitCode = 1;
});
