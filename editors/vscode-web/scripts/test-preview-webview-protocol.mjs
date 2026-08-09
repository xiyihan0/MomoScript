import assert from "node:assert/strict";
import {
  base64ToBytes,
  bytesToBase64,
  escapeHtml,
  isPreviewHostToWebviewMessage,
  isPreviewWebviewToHostMessage,
} from "../src/previewWebviewProtocol.ts";

const renderKey = "render-key";
const point = { pageIndex: 0, x: 0.25, y: 0.75 };
const viewport = { page: 0, x: 0.25, y: 0.75, zoom: 1, fitMode: "width" };
const exactExportState = {
  mode: "exact",
  availability: "ready",
  phase: "idle",
  message: "Ready",
  canSelectFormat: true,
  canExportDisplayed: false,
  canWaitForLatest: false,
  canCancel: false,
};

const hostMessages = [
  {
    type: "render",
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    imageAssets: [{ digest: "sha256:image", mimeType: "image/png", dataBase64: "AA==" }],
    pageSize: { width: 100, height: 200 },
    requestSequence: 1,
    traceId: "trace",
    renderKey,
    spans: [{ span: "1", start: 0, end: 1 }],
  },
  {
    type: "render-frame",
    sessionId: "session",
    frameKind: "new",
    dataBase64: "AA==",
    byteLength: 1,
    artifactDigest: "digest",
    sourceDigest: "source",
    backendGeneration: 1,
    rendererGeneration: 1,
    baseGeneration: 0,
    requestSequence: 2,
    traceId: "trace",
    renderKey,
    publishedAtEpochMs: 1,
  },
  { type: "renderer-reset" },
  { type: "status", message: "Rendering", error: false },
  { type: "restoreViewport", viewport },
  { type: "indicator", point },
  { type: "cursor" },
  { type: "exactExportState", state: exactExportState },
];

const renderer = {
  sessionId: "session",
  artifactDigest: "digest",
  sourceDigest: "source",
  backendGeneration: 1,
  generation: 1,
  baseGeneration: 0,
  frameKind: "new",
  byteLength: 1,
  pageGeometries: [{ pageIndex: 0, offsetY: 0, width: 100, height: 200 }],
  patchedNodes: 1,
  reusedNodes: 0,
  removedNodes: 0,
  pageBuffers: 1,
  frameDecodeMs: 1,
  rendererApplyMs: 1,
};
const webviewMessages = [
  { type: "ready" },
  {
    type: "visual-ready",
    requestSequence: 1,
    traceId: "trace",
    renderKey,
    locations: [],
    domUpdateMs: 1,
    locationMeasureMs: 0,
    renderer,
    viewportRenderMs: 1,
    iframeTransferMs: 1,
  },
  { type: "viewport", viewport },
  { type: "navigate", point },
  { type: "exact-export", format: "pdf", staleChoice: "wait-for-latest" },
  { type: "exact-export-cancel" },
  { type: "render-rejected", requestSequence: 1, renderKey, error: "rejected" },
  { type: "renderer-resync-needed", sessionId: "session", generation: 1 },
];

for (const message of hostMessages) {
  assert.equal(isPreviewHostToWebviewMessage(structuredClone(message)), true, `host message ${message.type} must round-trip`);
}
for (const message of webviewMessages) {
  assert.equal(isPreviewWebviewToHostMessage(structuredClone(message)), true, `webview message ${message.type} must round-trip`);
}

for (const malformed of [
  null,
  { type: "render" },
  { ...hostMessages[0], svg: 1 },
  { type: "status", message: "bad", error: "false" },
  { type: "restoreViewport", viewport: { ...viewport, zoom: "1" } },
  { type: "unknown-host" },
]) {
  assert.equal(isPreviewHostToWebviewMessage(malformed), false);
}
for (const malformed of [
  null,
  { type: "visual-ready", requestSequence: 1 },
  { ...webviewMessages[1], domUpdateMs: "1" },
  { type: "viewport", viewport: { ...viewport, fitMode: "unknown" } },
  { type: "navigate", point: { ...point, x: "0.25" } },
  { type: "exact-export", format: "txt" },
  { type: "render-rejected", requestSequence: "1", renderKey, error: "bad" },
  { type: "renderer-resync-needed", sessionId: "session", generation: 0 },
  { type: "unknown-webview" },
]) {
  assert.equal(isPreviewWebviewToHostMessage(malformed), false);
}

const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
assert.equal(escapeHtml(`<tag a="'&">`), "&lt;tag a=&quot;&#39;&amp;&quot;&gt;");
console.log("preview webview protocol contract passed");
