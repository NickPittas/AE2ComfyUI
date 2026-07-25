/* AE2ComfyUI panel logic: tabs, settings, connection status, workflow list.
   Queue orchestration is wired in Task 10 (needs comfy_client/patch_workflow). */
(function () {
    "use strict";

    function $(id) { return document.getElementById(id); }

    function setStatus(el, msg, cls) {
        el.textContent = msg;
        el.className = cls || "";
    }

    // --- Tabs --------------------------------------------------------------
    function showTab(name) {
        var gen = name === "generate";
        $("page-generate").classList.toggle("hidden", !gen);
        $("page-settings").classList.toggle("hidden", gen);
        $("tab-generate").classList.toggle("active", gen);
        $("tab-settings").classList.toggle("active", !gen);
    }

    // --- Settings page -----------------------------------------------------
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

    function saveSettings() {
        Object.keys(SETTING_FIELDS).forEach(function (id) {
            Settings.set(SETTING_FIELDS[id], $(id).value);
        });
        Settings.set("imageFormat", $("image-format").value);
        var vf = $("video-format").value;
        Settings.set("videoFormat", vf === "mp4" ? "mp4" : "mov");
        Settings.set("movCodec", vf === "mov422" ? "prores_422hq" : "prores_4444");
        Settings.set("colorMode", $("color-mode").value);
        Settings.set("placement", $("placement").value);
        Settings.set("resultFolder", $("result-folder").value);
        setStatus($("status-settings"), "Settings saved.", "ok");
        checkConnection();
    }

    // --- Connection + workflows -------------------------------------------
    function checkConnection() {
        var dot = $("conn-dot"), text = $("conn-text");
        dot.className = "dot";
        text.textContent = "checking…";
        return fetch(Settings.baseUrl() + "/ae_bridge/health", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.ok) {
                    dot.className = "dot on";
                    text.textContent = Settings.get("host") + ":" + Settings.get("port");
                    return true;
                }
                throw new Error("bad health response");
            })
            .catch(function () {
                dot.className = "dot";
                text.textContent = "disconnected";
                return false;
            });
    }

    function refreshWorkflows() {
        var sel = $("workflow");
        return fetch(Settings.baseUrl() + "/ae_bridge/workflows", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var keep = sel.value;
                sel.innerHTML = "";
                var list = (data && data.workflows) || [];
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
                    opt.textContent = (wf.source === "saved" ? "📄 " : "🗔 ") +
                        wf.name + " [" + wf.media + "]";
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

    // --- Media-type dependent rows ----------------------------------------
    function syncMediaRows() {
        var isVideo = $("media-type").value === "video";
        $("row-image-format").classList.toggle("hidden", isVideo);
        $("row-video-format").classList.toggle("hidden", !isVideo);
    }

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
        ["image-format", "video-format", "color-mode", "placement", "result-folder"]
            .forEach(function (id) {
                $(id).addEventListener("change", function () {
                    Settings.set(
                        id === "result-folder" ? "resultFolder"
                        : id === "image-format" ? "imageFormat"
                        : id === "video-format" ? "videoFormat"
                        : id === "color-mode" ? "colorMode" : "placement",
                        $(id).value);
                    if (id === "video-format") {
                        var vf = $(id).value;
                        Settings.set("videoFormat", vf === "mp4" ? "mp4" : "mov");
                        Settings.set("movCodec", vf === "mov422" ? "prores_422hq" : "prores_4444");
                    }
                });
            });

        // Queue is wired in Task 10; keep the button visible but inert.
        $("btn-queue").addEventListener("click", function () {
            setStatus($("status"), "Queue orchestration lands in Task 10.", "err");
        });

        loadSettings();
        syncMediaRows();
        checkConnection();
        refreshWorkflows();
    }

    document.addEventListener("DOMContentLoaded", init);
})();
