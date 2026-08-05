/* Node test for settings.js (localStorage shim path). Run: node tests/ae/test_settings.js */
"use strict";
const assert = require("assert");
const Settings = require("../../ae/ComfyUIBridge/js/settings.js");

assert.strictEqual(Settings.get("host"), "127.0.0.1", "default host");
assert.strictEqual(Settings.get("port"), 8188, "default port");
assert.strictEqual(Settings.baseUrl(), "http://127.0.0.1:8188");

Settings.set("host", "192.168.1.50");
Settings.set("port", 9000);
assert.strictEqual(Settings.get("host"), "192.168.1.50");
assert.strictEqual(Settings.get("port"), 9000, "port persists as number");
assert.strictEqual(Settings.baseUrl(), "http://192.168.1.50:9000");

assert.strictEqual(Settings.get("imageFormat"), "png", "default image format");
assert.strictEqual(Settings.get("movCodec"), "prores_4444", "default mov codec");
assert.strictEqual(Settings.get("colorMode"), "preserve_working_space");
assert.strictEqual(Settings.get("placement"), "above_selected_layer");
assert.strictEqual(Settings.get("prores4444Template"), "AE2C ProRes 4444");
assert.strictEqual(Settings.get("prores422hqTemplate"), "AE2C ProRes 422 HQ");
assert.strictEqual(Settings.get("h264Template"), "AE2C H.264 15 Mbps");
assert.strictEqual(Settings.get("maskTemplate"), "AE2C H.264 15 Mbps");

Settings.set("stagingFolder", "/tmp/stage");
const all = Settings.all();
assert.strictEqual(all.stagingFolder, "/tmp/stage");
assert.strictEqual(all.host, "192.168.1.50");

assert.throws(() => Settings.get("bogus"), /unknown setting/);
assert.throws(() => Settings.set("bogus", 1), /unknown setting/);

Settings.reset();
assert.strictEqual(Settings.get("host"), "127.0.0.1", "reset restores defaults");

console.log("test_settings.js: all assertions passed");
