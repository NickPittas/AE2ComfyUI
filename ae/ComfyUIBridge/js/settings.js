/* AE2ComfyUI panel settings, persisted in localStorage under ae2c.* keys.
   Plain script (no modules) so it loads in CEP and in Node tests. */
(function (root) {
    "use strict";

    var PREFIX = "ae2c.";

    var DEFAULTS = {
        host: "127.0.0.1",
        port: 8188,
        stagingFolder: "",
        resultFolder: "",
        workflowDirs: "",
        ameMainTemplate: "",
        ameMaskTemplate: "",
        prores4444Template: "AE2C ProRes 4444",
        prores422hqTemplate: "AE2C ProRes 422 HQ",
        h264Template: "AE2C H.264 15 Mbps",
        maskTemplate: "AE2C H.264 15 Mbps",
        imageFormat: "png",
        videoFormat: "mov",
        movCodec: "prores_4444",
        colorMode: "preserve_working_space",
        placement: "above_selected_layer"
    };

    function storage() {
        if (typeof localStorage !== "undefined") return localStorage;
        // Node test fallback: in-memory shim
        if (!root.__ae2cStore) {
            var m = {};
            root.__ae2cStore = {
                getItem: function (k) { return k in m ? m[k] : null; },
                setItem: function (k, v) { m[k] = String(v); },
                removeItem: function (k) { delete m[k]; }
            };
        }
        return root.__ae2cStore;
    }

    var Settings = {
        DEFAULTS: DEFAULTS,

        get: function (key) {
            if (!(key in DEFAULTS)) throw new Error("unknown setting: " + key);
            var raw = storage().getItem(PREFIX + key);
            if (raw === null || raw === undefined || raw === "") return DEFAULTS[key];
            if (typeof DEFAULTS[key] === "number") return parseInt(raw, 10);
            return raw;
        },

        set: function (key, value) {
            if (!(key in DEFAULTS)) throw new Error("unknown setting: " + key);
            storage().setItem(PREFIX + key, String(value));
        },

        all: function () {
            var out = {};
            for (var k in DEFAULTS) out[k] = this.get(k);
            return out;
        },

        baseUrl: function () {
            return "http://" + String(this.get("host")).trim() + ":" + this.get("port");
        },

        reset: function () {
            for (var k in DEFAULTS) storage().removeItem(PREFIX + k);
        }
    };

    root.Settings = Settings;
    if (typeof module !== "undefined" && module.exports) module.exports = Settings;
})(typeof window !== "undefined" ? window : globalThis);
