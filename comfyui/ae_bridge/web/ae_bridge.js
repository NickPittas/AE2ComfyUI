// AE bridge frontend extension.
//
// Publishes the currently open ComfyUI workflow to the backend
// /ae_bridge/workflows so the AE panel can list it in its workflow dropdown
// (source "open"). AE triggers execution by patching the stored API prompt
// and POSTing /prompt itself; this script only advertises workflows.
//
// Robustness policy: every ComfyUI/litegraph access is wrapped in try/catch.
// The extension degrades silently if any internal API moves between versions.

import { app } from "/scripts/app.js";

const FROM_IMAGE_TYPES = ["FromAE", "AE Bridge: From AE"];
const TO_IMAGE_TYPES = ["ToAE", "AE Bridge: To AE"];
const FROM_VIDEO_TYPES = ["FromAEVideo", "AE Bridge: From AE Video"];
const TO_VIDEO_TYPES = ["ToAEVideo", "AE Bridge: To AE Video"];
const PUBLISH_DEBOUNCE_MS = 800;
const POLL_MS = 3000;

// Per-tab stable id stored in sessionStorage so reloads keep the same slot.
let tabId = sessionStorage.getItem("ae_bridge_tab_id");
if (!tabId) {
    tabId = "wf-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("ae_bridge_tab_id", tabId);
}

let publishTimer = null;

function safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
}

function nodeTypeValues(node) {
    if (!node) return [];
    const values = [];
    for (const key of ["type", "comfyClass", "title"]) {
        const value = safe(() => node[key], null);
        if (value) values.push(String(value));
    }
    const data = safe(() => node.data || node.nodeData, null);
    if (data) {
        for (const key of ["type", "name", "display_name"]) {
            const value = safe(() => data[key], null);
            if (value) values.push(String(value));
        }
    }
    const props = safe(() => node.properties, null);
    if (props) {
        for (const key of ["class_type", "Node name for S&R"]) {
            const value = safe(() => props[key], null);
            if (value) values.push(String(value));
        }
    }
    return values;
}

function nodeMatchesAnyType(node, typeList) {
    const values = nodeTypeValues(node);
    return values.some(v => typeList.includes(v));
}

function collectNodes() {
    const g = app.graph;
    if (!g) return [];
    let nodes = safe(() => g._nodes, null);
    if (nodes && nodes.length) return nodes;
    nodes = safe(() => g.nodes, null);
    if (nodes) {
        if (Array.isArray(nodes)) return nodes;
        try { return Object.values(nodes); } catch (_) { return []; }
    }
    return [];
}

function workflowName() {
    const g = app.graph;
    const fromGraph = safe(() => g && g.name, null);
    if (fromGraph) return String(fromGraph);
    return safe(() => document.title, null) || "Workflow";
}

async function buildPayload() {
    const flags = { from_image: false, to_image: false, from_video: false, to_video: false };
    for (const n of collectNodes()) {
        if (nodeMatchesAnyType(n, FROM_IMAGE_TYPES)) flags.from_image = true;
        if (nodeMatchesAnyType(n, TO_IMAGE_TYPES)) flags.to_image = true;
        if (nodeMatchesAnyType(n, FROM_VIDEO_TYPES)) flags.from_video = true;
        if (nodeMatchesAnyType(n, TO_VIDEO_TYPES)) flags.to_video = true;
    }

    let prompt = null;
    try {
        const out = await app.graphToPrompt();
        prompt = (out && (out.output || out.prompt)) || out;
    } catch (_) {
        prompt = null; // graph not runnable as-is; still advertise the entry
    }

    return {
        workflows: [{
            id: tabId,
            name: workflowName(),
            flags: flags,
            prompt: prompt,
        }],
    };
}

async function publish() {
    try {
        const payload = await buildPayload();
        await fetch("/ae_bridge/workflows", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (_) {
        // best effort; the next tick/poll will retry
    }
}

function debouncedPublish() {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(publish, PUBLISH_DEBOUNCE_MS);
}

function wireGraphHooks() {
    const g = app.graph;
    if (!g) return false;
    for (const key of ["onNodeAdded", "onNodeRemoved", "onConnectionChange", "onGraphChanged"]) {
        try {
            const orig = g[key];
            g[key] = function () {
                try { if (orig) orig.apply(this, arguments); } catch (_) {}
                debouncedPublish();
            };
        } catch (_) {
            // property may be non-writable; skip
        }
    }
    return true;
}

app.registerExtension({
    name: "AEBridge.WorkflowPublisher",
    async setup() {
        // Graph may not be ready at setup; retry briefly.
        if (!wireGraphHooks()) {
            let tries = 0;
            const iv = setInterval(() => {
                if (wireGraphHooks() || ++tries > 20) clearInterval(iv);
            }, 500);
        }

        publish();
        // Periodic re-publish as a safety net (also refreshes the backend
        // timestamp so the entry doesn't expire while the tab is open).
        setInterval(publish, POLL_MS);

        // Re-publish after ComfyUI finishes a prompt build / load.
        try {
            const origLoad = app.loadGraphData;
            if (typeof origLoad === "function") {
                app.loadGraphData = function () {
                    const p = origLoad.apply(this, arguments);
                    try { Promise.resolve(p).finally(debouncedPublish); } catch (_) {}
                    return p;
                };
            }
        } catch (_) {}
    },
});
